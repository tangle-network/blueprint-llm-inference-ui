import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTangleMode, useTangleWallet } from '@tangle-network/blueprint-ui/iframe'
import { useInferenceSession, type SessionState } from './useInferenceSession'

// ── Types (from Bazaar DeveloperChatPage) ────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  ms?: number
  error?: boolean
  streaming?: boolean
}

const STARTER_PROMPTS = [
  'Write a Python script to hash a file',
  'Explain zero-knowledge proofs simply',
  'Design a REST API for a todo app',
]

const DEFAULT_FUND_AMOUNT = 1_000_000_000_000_000_000n

let msgCounter = 0
const nextId = () => `m${msgCounter++}`

// ── Markdown renderer (copied from Bazaar) ───────────────────────────────────

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
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: code.join('\n') }); continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')); i += 1 }
      blocks.push({ type: 'ul', items }); continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')); i += 1 }
      blocks.push({ type: 'ol', items }); continue
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
      out.push(<code key={out.length} className="break-words rounded-[4px] bg-[var(--s-bg)]/70 px-1 py-0.5 font-data text-[0.92em] text-[var(--s-text)]">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={out.length} className="font-semibold text-[var(--s-text)]">{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link?.[2] ?? ''
      const safeHref = /^https?:\/\//.test(href) ? href : undefined
      out.push(safeHref ? <a key={out.length} href={safeHref} target="_blank" rel="noreferrer" className="text-[var(--s-accent)] underline underline-offset-2">{link?.[1] ?? href}</a> : token)
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
    <div className="chat-markdown min-w-0 break-words font-body text-[15px] leading-relaxed">
      {blocks.map((block, index) => {
        if (block.type === 'h') {
          return (
            <div key={index} className={`mb-1 mt-3 font-display font-semibold text-[var(--s-text)] first:mt-0 ${block.level === 1 ? 'text-[18px]' : 'text-[16px]'}`}>
              {inlineMarkdown(block.text)}
            </div>
          )
        }
        if (block.type === 'code') {
          return (
            <pre key={index} className="my-2 max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-[8px] border border-[var(--s-border)] bg-[var(--s-bg)]/70 p-3 font-data text-[13px] leading-relaxed text-[var(--s-text)]">
              <code className="break-words whitespace-pre-wrap">{block.text}</code>
            </pre>
          )
        }
        if (block.type === 'ul' || block.type === 'ol') {
          const Tag = block.type === 'ul' ? 'ul' : 'ol'
          return (
            <Tag key={index} className={`my-2 space-y-1 break-words pl-5 ${block.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}
            </Tag>
          )
        }
        return (
          <p key={index} className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">
            {inlineMarkdown(block.text)}
          </p>
        )
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

// ── Main (mirrors Bazaar DeveloperChatPage layout 1:1) ──────────────────────

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
  const lastLen = messages[messages.length - 1]?.content.length ?? 0

  // Auto-scroll (same rAF double-frame trick as Bazaar)
  useEffect(() => {
    if (messages.length === 0) return
    let secondFrame = 0
    const frame = requestAnimationFrame(() => {
      const log = logRef.current
      if (!log) return
      log.scrollTop = log.scrollHeight
      secondFrame = requestAnimationFrame(() => {
        const nextLog = logRef.current
        if (nextLog) nextLog.scrollTop = nextLog.scrollHeight
      })
    })
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame) }
  }, [busy, messages.length, lastLen])

  const appendDelta = useCallback((id: string, delta: string) => {
    setMessages((current) =>
      current.map((m) => (m.id === id ? { ...m, content: `${m.content}${delta}`, streaming: true } : m)),
    )
  }, [])

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || busy) return
    const user: ChatMessage = { id: nextId(), role: 'user', content: prompt }
    const assistantId = nextId()
    const nextMessages = [...messages, user]
    setMessages([...nextMessages, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setBusy(true)

    if (!session.client) {
      if (import.meta.env.DEV) {
        simulateStream(prompt, (delta) => appendDelta(assistantId, delta), () => {
          setMessages((current) => current.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)))
          setBusy(false)
        })
      } else {
        setBusy(false)
      }
      return
    }

    const started = performance.now()
    abortRef.current = session.client.chatStream(
      nextMessages.map((m) => ({ role: m.role, content: m.content })),
      {
        onToken: ({ accumulated }) => appendDelta(assistantId, accumulated),
        onDone: (full) => {
          setMessages((current) => current.map((m) => (m.id === assistantId ? { ...m, content: full, streaming: false, ms: Math.round(performance.now() - started) } : m)))
          setBusy(false)
        },
        onError: (err) => {
          setMessages((current) => current.map((m) => (m.id === assistantId ? { ...m, content: err.message, error: true, streaming: false } : m)))
          setBusy(false)
        },
      },
    )
  }, [busy, input, messages, session.client, appendDelta])

  const stop = useCallback(() => {
    abortRef.current?.()
    abortRef.current = null
    setBusy(false)
    setMessages((current) => current.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
  }, [])

  const fund = useCallback(() => {
    session.fund(DEFAULT_FUND_AMOUNT).catch(() => { /* surfaced via session.error */ })
  }, [session])

  // ── Status badge ──
  const statusTone = session.state === 'ready' ? 'emerald' : session.state === 'error' || session.state === 'unconfigured' ? 'crimson' : session.state === 'needs-funding' || session.state === 'no-wallet' ? 'amber' : 'neutral'
  const statusLabel = session.state === 'ready' ? 'Ready' : session.state === 'error' ? 'Error' : session.state === 'loading' ? 'Connecting' : session.state === 'needs-funding' ? 'Needs credits' : session.state === 'no-wallet' ? 'No wallet' : session.state === 'no-operator' ? 'No operator' : session.state === 'unconfigured' ? 'Unconfigured' : session.state

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ── Header (same structure as Bazaar) ── */}
      <header className="shrink-0 border-b border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_82%,transparent)] px-3 py-3 backdrop-blur-xl sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-gradient-to-br from-[var(--s-accent)] to-[var(--s-brand)] text-[14px] font-black text-[var(--s-bg)]">◆</span>
              <h1 className="truncate font-display text-[20px] font-semibold text-[var(--s-text)]">Chat</h1>
              {mode === 'dev' && <span className={`rounded-full border px-2 py-0.5 font-data text-[11px] font-semibold ${statusTone === 'emerald' ? 'border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] text-[var(--s-emerald)]' : statusTone === 'crimson' ? 'border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : statusTone === 'amber' ? 'border-[var(--s-amber)]/30 bg-[var(--s-amber-soft)] text-[var(--s-amber)]' : 'border-[var(--s-border)] text-[var(--s-text-muted)]'}`}>{mode === 'dev' ? 'dev' : statusLabel}</span>}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
              {wallet.address ? (
                <span className="truncate">{shorten(wallet.address)}</span>
              ) : (
                <span>Not connected</span>
              )}
              {session.info?.model && (
                <>
                  <span className="text-[var(--s-text-subtle)]">/</span>
                  <span className="truncate">{session.info.model}</span>
                </>
              )}
              {session.balance !== null && (
                <>
                  <span className="text-[var(--s-text-subtle)]">/</span>
                  <span>{formatTokens(Number(session.balance))} credits</span>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Thread (same structure as Bazaar) ── */}
      <section ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3">
          {messages.length === 0 ? (
            <Gate session={session} mode={mode} onFund={fund} onStarter={setInput} />
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <span className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border ${m.error ? 'border-[var(--s-crimson)]/35 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : 'border-[var(--s-brand)]/35 bg-[var(--s-brand-soft)] text-[var(--s-brand)]'}`}>
                    <span className={m.error ? 'i-ph:warning-circle text-[15px]' : 'i-ph:sparkle text-[15px]'} />
                  </span>
                )}
                <div className={`min-w-0 max-w-[min(86%,720px)] overflow-hidden rounded-[10px] border px-3 py-2 ${m.role === 'user' ? 'border-[var(--s-accent)]/30 bg-[var(--s-accent-soft)] text-[var(--s-text)]' : m.error ? 'border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : 'border-[var(--s-border)] bg-[var(--s-surface)] text-[var(--s-text-secondary)]'}`}>
                  {m.role === 'assistant' && !m.error && m.content ? (
                    <ChatMarkdown content={m.content} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words font-body text-[15px] leading-relaxed">{m.content}</div>
                  )}
                  {m.streaming && !m.error && (
                    <span className="mt-1 inline-block h-4 w-1 animate-pulse rounded-full bg-[var(--s-accent)] align-middle" />
                  )}
                  {m.ms !== undefined && (
                    <div className="mt-2 border-t border-[var(--s-divider)] pt-2 font-data text-[12px] leading-relaxed text-[var(--s-text-muted)]">
                      {m.ms} ms
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ── Composer (same structure as Bazaar) ── */}
      <footer className="shrink-0 border-t border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_86%,transparent)] p-3 backdrop-blur-xl sm:p-4">
        <div className="mx-auto max-w-4xl overflow-visible rounded-[12px] border border-[var(--s-border)] bg-[var(--s-surface)] shadow-[0_10px_40px_rgba(0,0,0,0.12)]">
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
            className="max-h-[28dvh] min-h-[92px] w-full resize-none bg-transparent px-3 py-3 font-body text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)]"
            placeholder={composerPlaceholder(session.state, mode)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--s-divider)] px-2 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate font-data text-[12px] font-semibold uppercase tracking-wide text-[var(--s-text-muted)]">
                {session.info?.model ?? (mode === 'dev' ? 'dev mode' : 'Connecting…')}
              </span>
            </div>
            {busy ? (
              <button onClick={stop} className="btn-secondary h-9 whitespace-nowrap">
                <span className="i-ph:stop text-[16px]" /> Stop
              </button>
            ) : (
              <button onClick={send} disabled={!canSend} className="btn-primary h-9 w-11 !px-0" title="Send">
                <span className={busy ? 'i-ph:circle-notch animate-spin text-[18px]' : 'i-ph:paper-plane-tilt text-[18px]'} />
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

function composerPlaceholder(state: SessionState, mode: 'bridge' | 'dev'): string {
  if (mode === 'dev') return 'Message your model... (dev)'
  switch (state) {
    case 'no-wallet': return 'Connect a wallet in Tangle Cloud to start'
    case 'no-operator': return 'No operator has deployed this service yet'
    case 'needs-funding': return 'Fund credits to start chatting'
    case 'ready': return 'Message the model...'
    default: return 'Preparing session...'
  }
}

// ── Gate / empty state (same structure as Bazaar) ────────────────────────────

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
      <div className="w-full max-w-[680px] self-center pt-[clamp(32px,12dvh,112px)]">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-gradient-to-br from-[var(--s-accent)] to-[var(--s-brand)]" />
          <div className="min-w-0">
            <h2 className="font-display text-[24px] font-semibold leading-tight text-[var(--s-text)]">Dev mode</h2>
            <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">Standalone — send a prompt for a simulated stream.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {STARTER_PROMPTS.map((p) => (
            <button key={p} onClick={() => onStarter(p)} className="min-h-[74px] rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] leading-relaxed text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]">{p}</button>
          ))}
        </div>
      </div>
    )
  }

  if (session.state === 'needs-funding') {
    return (
      <div className="w-full max-w-[480px] self-center pt-[clamp(32px,12dvh,112px)] text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[16px] bg-gradient-to-br from-[var(--s-accent)] to-[var(--s-brand)] shadow-[var(--s-glow-violet)]">
          <span className="i-ph:coins text-[24px] text-[var(--s-bg)]" />
        </span>
        <h2 className="mt-4 font-display text-[24px] font-semibold text-[var(--s-text)]">Fund your credits</h2>
        <p className="mt-2 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">Deposit once to unlock pay-per-token inference. Each request is authorized by an ephemeral key — the operator never sees your wallet.</p>
        <button onClick={onFund} disabled={session.isFunding} className="btn-primary mt-5 h-11 px-6">
          <span className="i-ph:lightning text-[16px]" /> {session.isFunding ? 'Funding...' : 'Fund credits'}
        </button>
      </div>
    )
  }

  const copy: Partial<Record<SessionState, { title: string; body: string; icon: string }>> = {
    'no-wallet': { title: 'Connect to start', body: 'Your Tangle Cloud wallet connects automatically. Open this blueprint from the dashboard.', icon: 'i-ph:wallet' },
    'no-operator': { title: 'No operator available', body: 'No operator is running this model yet. Check back soon.', icon: 'i-ph:hard-drives' },
    'loading': { title: 'Connecting…', body: 'Linking your wallet to the operator and checking your credit balance.', icon: 'i-ph:circle-notch' },
    'unconfigured': { title: 'Payments not configured', body: "This operator hasn't enabled shielded credits yet.", icon: 'i-ph:warning-circle' },
    'error': { title: 'Connection failed', body: session.error ?? 'Something went wrong. Try refreshing.', icon: 'i-ph:warning-circle' },
    'ready': { title: 'Ready to chat', body: "Responses stream live from the operator's model, billed against your prepaid credits.", icon: 'i-ph:sparkle' },
  }

  const c = copy[session.state]
  if (!c) return null

  return (
    <div className="w-full max-w-[680px] self-center pt-[clamp(32px,12dvh,112px)]">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-[9px] border border-[var(--s-border)] bg-[var(--s-surface)] ${session.state === 'loading' ? 'animate-spin' : ''} text-[var(--s-text-muted)]`}>
          <span className={`${c.icon} text-[18px]`} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-[24px] font-semibold leading-tight text-[var(--s-text)]">{c.title}</h2>
          <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">{c.body}</p>
        </div>
      </div>
      {session.state === 'ready' && (
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {STARTER_PROMPTS.map((p) => (
            <button key={p} onClick={() => onStarter(p)} className="min-h-[74px] rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] leading-relaxed text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]">{p}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Dev simulate ─────────────────────────────────────────────────────────────

function simulateStream(prompt: string, onDelta: (delta: string) => void, onDone: () => void) {
  const canned = `You said: "${prompt}". This is a simulated stream — in production these tokens come from the operator's vLLM endpoint over SSE, billed against prepaid shielded credits.`
  const tokens = canned.split(' ')
  let i = 0
  let acc = ''
  const interval = setInterval(() => {
    if (i >= tokens.length) { clearInterval(interval); onDone(); return }
    acc += (i === 0 ? '' : ' ') + tokens[i]
    i += 1
    onDelta(acc)
  }, 40)
}
