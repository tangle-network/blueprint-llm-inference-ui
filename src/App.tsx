import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTangleMode, useTangleWallet } from '@tangle-network/blueprint-ui/iframe'
import { useInferenceSession, type SessionState } from './useInferenceSession'

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
  ms?: number
}

let messageCounter = 0
const nextId = () => `m${messageCounter++}`

const DEFAULT_FUND_AMOUNT = 1_000_000_000_000_000_000n

const STARTER_PROMPTS = [
  'Write a Python script to hash a file',
  'Explain zero-knowledge proofs simply',
  'What are the best practices for REST API design?',
]

// ── Markdown (ported 1:1 from Bazaar) ────────────────────────────────────────

function markdownBlocks(input: string) {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<
    | { type: 'p'; text: string }
    | { type: 'h'; level: number; text: string }
    | { type: 'ul'; items: string[] }
    | { type: 'ol'; items: string[] }
    | { type: 'code'; lang: string; text: string }
  > = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) { i += 1; continue }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) { blocks.push({ type: 'h', level: heading[1]!.length, text: heading[2]! }); i += 1; continue }
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) { code.push(lines[i] ?? ''); i += 1 }
      i += 1
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: code.join('\n') })
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')); i += 1 }
      blocks.push({ type: 'ul', items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')); i += 1 }
      blocks.push({ type: 'ol', items })
      continue
    }
    const paragraph: string[] = [line]
    i += 1
    while (i < lines.length && (lines[i] ?? '').trim() && !/^```/.test(lines[i] ?? '') && !/^(#{1,3})\s+/.test(lines[i] ?? '') && !/^\s*[-*]\s+/.test(lines[i] ?? '') && !/^\s*\d+\.\s+/.test(lines[i] ?? '')) { paragraph.push(lines[i] ?? ''); i += 1 }
    blocks.push({ type: 'p', text: paragraph.join('\n') })
  }
  return blocks
}

function inlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      out.push(<code key={out.length} className="inline">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={out.length}>{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link?.[2] ?? ''
      const safeHref = /^https?:\/\//.test(href) ? href : undefined
      out.push(safeHref ? <a key={out.length} href={safeHref} target="_blank" rel="noreferrer">{link?.[1] ?? href}</a> : token)
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function ChatMarkdown({ content }: { content: string }) {
  const blocks = markdownBlocks(content)
  if (blocks.length === 0) return null
  return (
    <div className="chat-md">
      {blocks.map((block, index) => {
        if (block.type === 'h') {
          const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3')
          return <Tag key={index}>{inlineMarkdown(block.text)}</Tag>
        }
        if (block.type === 'code') {
          return <pre key={index}><code>{block.text}</code></pre>
        }
        if (block.type === 'ul' || block.type === 'ol') {
          const Tag = block.type === 'ul' ? 'ul' : 'ol'
          return <Tag key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</Tag>
        }
        return <p key={index}>{inlineMarkdown(block.text)}</p>
      })}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  return Math.floor(value).toLocaleString('en-US')
}

// ── Main app ─────────────────────────────────────────────────────────────────

export function App() {
  const mode = useTangleMode()
  const wallet = useTangleWallet()
  const session = useInferenceSession()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLElement | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  const canChat = session.state === 'ready' || (mode === 'dev' && import.meta.env.DEV)
  const canSend = !busy && input.trim().length > 0 && canChat

  // Auto-scroll like the Bazaar does
  const lastLen = messages[messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    if (messages.length === 0) return
    const frame = requestAnimationFrame(() => {
      const log = logRef.current
      if (!log) return
      log.scrollTop = log.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [busy, messages.length, lastLen])

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || busy) return

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: prompt }
    const assistantId = nextId()
    const history = [...messages, userMsg]
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setBusy(true)

    const patch = (content: string, streaming: boolean, extra?: Partial<ChatMessage>) =>
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content, streaming, ...extra } : m))

    if (!session.client) {
      if (import.meta.env.DEV) {
        simulateStream(prompt, patch, () => setBusy(false))
      } else {
        setBusy(false)
      }
      return
    }

    const started = performance.now()
    abortRef.current = session.client.chatStream(
      history.map(({ role, content }) => ({ role, content })),
      {
        onToken: ({ accumulated }) => patch(accumulated, true),
        onDone: (full) => { patch(full, false, { ms: Math.round(performance.now() - started) }); setBusy(false) },
        onError: (err) => { patch(err.message, false, { error: true }); setBusy(false) },
      },
    )
  }, [busy, input, messages, session.client])

  const stop = useCallback(() => {
    abortRef.current?.()
    abortRef.current = null
    setBusy(false)
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m))
  }, [])

  const fund = useCallback(() => {
    session.fund(DEFAULT_FUND_AMOUNT).catch(() => { /* surfaced via session.error */ })
  }, [session])

  return (
    <div className="chat-shell">
      <Header
        mode={mode}
        walletAddress={wallet.address}
        model={session.info?.model ?? null}
        balance={session.balance}
        state={session.state}
      />

      <section ref={logRef} className="chat-log">
        <div className="chat-log-inner">
          {messages.length === 0 ? (
            <Gate session={session} mode={mode} onFund={fund} onStarter={setInput} />
          ) : (
            messages.map((m) => <MessageRow key={m.id} message={m} />)
          )}
        </div>
      </section>

      <footer className="chat-composer">
        <div className="chat-composer-box">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) send()
              }
            }}
            rows={3}
            placeholder={composerPlaceholder(session.state, mode)}
          />
          <div className="chat-composer-bar">
            <div className="chat-composer-model">
              {session.info?.model ?? (mode === 'dev' ? 'dev mode' : 'Connecting…')}
            </div>
            {busy ? (
              <button type="button" className="chat-stop-btn" onClick={stop}>Stop</button>
            ) : (
              <button type="button" className="chat-send-btn" onClick={send} disabled={!canSend} title="Send">
                ➤
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

function composerPlaceholder(state: SessionState, mode: 'bridge' | 'dev'): string {
  if (mode === 'dev') return 'Ask anything… (dev)'
  switch (state) {
    case 'no-wallet': return 'Connect a wallet in Tangle Cloud to start'
    case 'no-operator': return 'No operator has deployed this service yet'
    case 'needs-funding': return 'Fund credits to start chatting'
    case 'ready': return 'Message the model…'
    default: return 'Preparing session…'
  }
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({
  mode, walletAddress, model, balance, state,
}: {
  mode: 'bridge' | 'dev'
  walletAddress: string | null
  model: string | null
  balance: bigint | null
  state: SessionState
}) {
  const statusLabel =
    state === 'ready' ? 'Ready' :
    state === 'error' ? 'Error' :
    state === 'loading' ? 'Connecting' :
    state === 'needs-funding' ? 'Needs credits' :
    state === 'no-wallet' ? 'No wallet' :
    state === 'no-operator' ? 'No operator' :
    state === 'unconfigured' ? 'Unconfigured' : state

  const statusTone =
    state === 'ready' ? 'ok' :
    state === 'error' || state === 'unconfigured' ? 'err' :
    state === 'needs-funding' || state === 'no-wallet' ? 'warn' : 'muted'

  return (
    <header className="chat-header">
      <div className="chat-header-row">
        <div className="chat-header-title">
          <span className="chat-logo">◆</span>
          <h1>Chat</h1>
          {mode === 'dev' && <span className="chat-badge muted">dev</span>}
          <span className={`chat-badge ${statusTone}`}>{statusLabel}</span>
        </div>
      </div>
      <div className="chat-header-meta">
        {walletAddress ? (
          <>{shorten(walletAddress)}</>
        ) : (
          <>Not connected</>
        )}
        {model && (<><span className="dot">/</span>{model}</>)}
        {balance !== null && (<><span className="dot">/</span>{formatTokens(Number(balance))} credits</>)}
      </div>
    </header>
  )
}

// ── Gate / empty state ───────────────────────────────────────────────────────

function Gate({
  session, mode, onFund, onStarter,
}: {
  session: ReturnType<typeof useInferenceSession>
  mode: 'bridge' | 'dev'
  onFund: () => void
  onStarter: (text: string) => void
}) {
  if (mode === 'dev') {
    return (
      <div className="chat-welcome">
        <div className="chat-welcome-head">
          <span className="chat-welcome-logo" />
          <div>
            <h2>Dev mode</h2>
            <p>Standalone — send a prompt for a simulated stream. Embedded in Tangle Cloud, this streams from a real operator.</p>
          </div>
        </div>
        <div className="chat-starters">
          {STARTER_PROMPTS.map((p) => (
            <button key={p} className="chat-starter" onClick={() => onStarter(p)}>{p}</button>
          ))}
        </div>
      </div>
    )
  }

  switch (session.state) {
    case 'no-wallet':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>Connect to start</h2>
              <p>Your Tangle Cloud wallet connects automatically. Open this blueprint from the dashboard.</p>
            </div>
          </div>
        </div>
      )
    case 'no-operator':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>No operator available</h2>
              <p>No operator is running this model yet. Check back soon.</p>
            </div>
          </div>
        </div>
      )
    case 'loading':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>Connecting…</h2>
              <p>Linking your wallet to the operator.</p>
            </div>
          </div>
        </div>
      )
    case 'unconfigured':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>Payments not configured</h2>
              <p>This operator hasn't enabled shielded credits yet.</p>
            </div>
          </div>
        </div>
      )
    case 'error':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>Connection failed</h2>
              <p>{session.error ?? 'Something went wrong.'}</p>
            </div>
          </div>
        </div>
      )
    case 'needs-funding':
      return (
        <div className="chat-fund">
          <div className="chat-fund-logo" />
          <h2>Fund your credits</h2>
          <p>Deposit once to unlock pay-per-token inference. Each request is authorized by an ephemeral key — the operator never sees your wallet.</p>
          <button type="button" className="chat-fund-btn" onClick={onFund} disabled={session.isFunding}>
            {session.isFunding ? 'Funding…' : 'Fund credits'}
          </button>
        </div>
      )
    case 'ready':
      return (
        <div className="chat-welcome">
          <div className="chat-welcome-head">
            <span className="chat-welcome-logo" />
            <div>
              <h2>Ready to chat</h2>
              <p>Responses stream live from the operator's model, billed against your prepaid credits.</p>
            </div>
          </div>
          <div className="chat-starters">
            {STARTER_PROMPTS.map((p) => (
              <button key={p} className="chat-starter" onClick={() => onStarter(p)}>{p}</button>
            ))}
          </div>
        </div>
      )
  }
}

// ── Message row ──────────────────────────────────────────────────────────────

function MessageRow({ message }: { message: ChatMessage }) {
  return (
    <div className={`msg-row ${message.role}`}>
      {message.role === 'assistant' && (
        <span className={`msg-avatar ${message.error ? 'err' : ''}`}>
          {message.error ? '!' : '✦'}
        </span>
      )}
      <div className={`msg-bubble ${message.role} ${message.error ? 'error' : ''}`}>
        {message.role === 'assistant' && !message.error && message.content ? (
          <ChatMarkdown content={message.content} />
        ) : (
          <div className="msg-text">{message.content}</div>
        )}
        {message.streaming && !message.error && (
          <span className="msg-cursor" />
        )}
        {message.ms !== undefined && (
          <div className="msg-meta">{message.ms} ms</div>
        )}
      </div>
    </div>
  )
}

// ── Dev simulate ─────────────────────────────────────────────────────────────

function simulateStream(
  prompt: string,
  patch: (content: string, streaming: boolean, extra?: Partial<ChatMessage>) => void,
  onDone: () => void,
) {
  const canned = `You said: "${prompt}". This is a simulated stream — in production these tokens come from the operator's vLLM endpoint over SSE, billed against prepaid shielded credits.`
  const tokens = canned.split(' ')
  let i = 0
  let acc = ''
  const interval = setInterval(() => {
    if (i >= tokens.length) {
      clearInterval(interval)
      patch(acc, false)
      onDone()
      return
    }
    acc += (i === 0 ? '' : ' ') + tokens[i]
    i += 1
    patch(acc, true)
  }, 40)
}
