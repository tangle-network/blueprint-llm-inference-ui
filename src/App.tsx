import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTangleMode, useTangleWallet, useTangleService } from '@tangle-network/blueprint-ui/iframe'
import { useInferenceSession, type SessionState } from './useInferenceSession'

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Markdown (from Bazaar) ───────────────────────────────────────────────────

function markdownBlocks(input: string) {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<{ type: 'p'; text: string } | { type: 'h'; level: number; text: string } | { type: 'ul'; items: string[] } | { type: 'ol'; items: string[] } | { type: 'code'; lang: string; text: string }> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) { i += 1; continue }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) { blocks.push({ type: 'h', level: heading[1]!.length, text: heading[2]! }); i += 1; continue }
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) { const code: string[] = []; i += 1; while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) { code.push(lines[i] ?? ''); i += 1 } i += 1; blocks.push({ type: 'code', lang: fence[1] ?? '', text: code.join('\n') }); continue }
    if (/^\s*[-*]\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')); i += 1 } blocks.push({ type: 'ul', items }); continue }
    if (/^\s*\d+\.\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) { items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')); i += 1 } blocks.push({ type: 'ol', items }); continue }
    const para: string[] = [line]; i += 1
    while (i < lines.length && (lines[i] ?? '').trim() && !/^```/.test(lines[i] ?? '') && !/^(#{1,3})\s+/.test(lines[i] ?? '') && !/^\s*[-*]\s+/.test(lines[i] ?? '') && !/^\s*\d+\.\s+/.test(lines[i] ?? '')) { para.push(lines[i] ?? ''); i += 1 }
    blocks.push({ type: 'p', text: para.join('\n') })
  }
  return blocks
}

function inlineMd(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={out.length} className="break-words rounded-[4px] bg-[var(--s-bg)]/70 px-1 py-0.5 font-data text-[0.92em] text-[var(--s-text)]">{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<strong key={out.length} className="font-semibold text-[var(--s-text)]">{t.slice(2, -2)}</strong>)
    else { const l = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/); const h = l?.[2] ?? ''; const safe = /^https?:\/\//.test(h) ? h : undefined; out.push(safe ? <a key={out.length} href={safe} target="_blank" rel="noreferrer" className="text-[var(--s-accent)] underline underline-offset-2">{l?.[1] ?? h}</a> : t) }
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function ChatMarkdown({ content }: { content: string }) {
  const blocks = markdownBlocks(content)
  if (!blocks.length) return null
  return (
    <div className="chat-markdown min-w-0 break-words font-body text-[15px] leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === 'h') return <div key={i} className={`mb-1 mt-3 font-display font-semibold text-[var(--s-text)] first:mt-0 ${b.level === 1 ? 'text-[18px]' : 'text-[16px]'}`}>{inlineMd(b.text)}</div>
        if (b.type === 'code') return <pre key={i} className="my-2 max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-[8px] border border-[var(--s-border)] bg-[var(--s-bg)]/70 p-3 font-data text-[13px] leading-relaxed text-[var(--s-text)]"><code>{b.text}</code></pre>
        if (b.type === 'ul' || b.type === 'ol') { const T = b.type === 'ul' ? 'ul' : 'ol'; return <T key={i} className={`my-2 space-y-1 break-words pl-5 ${b.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>{b.items.map((it, j) => <li key={j}>{inlineMd(it)}</li>)}</T> }
        return <p key={i} className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">{inlineMd(b.text)}</p>
      })}
    </div>
  )
}

function shorten(a: string) { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a }

// ── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const mode = useTangleMode()
  const wallet = useTangleWallet()
  const service = useTangleService()
  const session = useInferenceSession()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLElement | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  const canChat = session.state === 'ready' || (mode === 'dev' && import.meta.env.DEV)
  const canSend = !busy && input.trim().length > 0 && canChat
  const lastLen = messages[messages.length - 1]?.content.length ?? 0

  useEffect(() => {
    if (!messages.length) return
    let f2 = 0
    const f = requestAnimationFrame(() => { const l = logRef.current; if (l) l.scrollTop = l.scrollHeight; f2 = requestAnimationFrame(() => { const l2 = logRef.current; if (l2) l2.scrollTop = l2.scrollHeight }) })
    return () => { cancelAnimationFrame(f); cancelAnimationFrame(f2) }
  }, [busy, messages.length, lastLen])

  const appendDelta = useCallback((id: string, delta: string) => {
    setMessages(p => p.map(m => m.id === id ? { ...m, content: `${m.content}${delta}`, streaming: true } : m))
  }, [])

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || !canSend) return
    const user: ChatMessage = { id: nextId(), role: 'user', content: prompt }
    const assistantId = nextId()
    const history = [...messages, user]
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setBusy(true)

    if (!session.client) {
      if (import.meta.env.DEV) {
        simulateStream(prompt, (d) => appendDelta(assistantId, d), () => { setMessages(p => p.map(m => m.id === assistantId ? { ...m, streaming: false } : m)); setBusy(false) })
      } else { setBusy(false) }
      return
    }

    const started = performance.now()
    abortRef.current = session.client.chatStream(
      history.map(m => ({ role: m.role, content: m.content })),
      {
        onToken: ({ accumulated }) => appendDelta(assistantId, accumulated),
        onDone: (full) => { setMessages(p => p.map(m => m.id === assistantId ? { ...m, content: full, streaming: false, ms: Math.round(performance.now() - started) } : m)); setBusy(false) },
        onError: (err) => { setMessages(p => p.map(m => m.id === assistantId ? { ...m, content: err.message, error: true, streaming: false } : m)); setBusy(false) },
      },
    )
  }, [canSend, input, messages, session.client, appendDelta])

  const stop = useCallback(() => { abortRef.current?.(); abortRef.current = null; setBusy(false); setMessages(p => p.map(m => m.streaming ? { ...m, streaming: false } : m)) }, [])

  const fund = useCallback(() => { session.fund(DEFAULT_FUND_AMOUNT).catch(() => {}) }, [session])

  // Status for header
  const isBridge = mode === 'bridge'
  const isReady = session.state === 'ready'
  const statusLabel = !isBridge ? 'Standalone' : isReady ? 'Ready' : session.state === 'error' ? 'Error' : session.state === 'loading' ? 'Connecting' : session.state === 'needs-funding' ? 'Needs credits' : session.state === 'no-wallet' ? 'No wallet' : session.state === 'no-operator' ? 'No instance' : session.state === 'unconfigured' ? 'Not configured' : session.state
  const statusTone = isReady ? 'emerald' : session.state === 'error' ? 'crimson' : session.state === 'needs-funding' || session.state === 'no-wallet' ? 'amber' : 'neutral'
  const badgeClass = statusTone === 'emerald' ? 'border-[var(--s-emerald)]/30 bg-[var(--s-emerald-soft)] text-[var(--s-emerald)]' : statusTone === 'crimson' ? 'border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : statusTone === 'amber' ? 'border-[var(--s-amber)]/30 bg-[var(--s-amber-soft)] text-[var(--s-amber)]' : 'border-[var(--s-border)] text-[var(--s-text-muted)]'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_82%,transparent)] px-3 py-3 backdrop-blur-xl sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-gradient-to-br from-[var(--s-accent)] to-[var(--s-brand)] text-[14px] font-black text-[var(--s-bg)]">◆</span>
              <h1 className="truncate font-display text-[20px] font-semibold text-[var(--s-text)]">LLM Inference</h1>
              <span className={`rounded-full border px-2 py-0.5 font-data text-[11px] font-semibold ${badgeClass}`}>{statusLabel}</span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-data text-[12px] uppercase tracking-wide text-[var(--s-text-muted)]">
              {session.info?.model && <><span className="truncate text-[var(--s-text-secondary)]">{session.info.model}</span><span className="text-[var(--s-text-subtle)]">/</span></>}
              {session.operator && <><span className="truncate">{shorten(session.operator.address)}</span><span className="text-[var(--s-text-subtle)]">/</span></>}
              {session.balance !== null && <><span>{session.balance > 0n ? `${session.balance.toLocaleString()} cr` : '0 credits'}</span></>}
              {!session.operator && !session.info && <span>{wallet.address ? `Connected ${shorten(wallet.address)}` : 'Not connected'}</span>}
            </div>
          </div>
        </div>
      </header>

      {/* ── Thread ── */}
      <section ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3">
          {messages.length === 0 ? (
            <Gate session={session} mode={mode} walletConnected={wallet.isConnected} hasOperator={!!session.operator || service.operators.length > 0} onFund={fund} onStarter={setInput} />
          ) : (
            messages.map(m => (
              <div key={m.id} className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <span className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border ${m.error ? 'border-[var(--s-crimson)]/35 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : 'border-[var(--s-brand)]/35 bg-[var(--s-brand-soft)] text-[var(--s-brand)]'}`}>
                    <span className={m.error ? 'i-ph:warning-circle text-[15px]' : 'i-ph:sparkle text-[15px]'} />
                  </span>
                )}
                <div className={`min-w-0 max-w-[min(86%,720px)] overflow-hidden rounded-[10px] border px-3 py-2 ${m.role === 'user' ? 'border-[var(--s-accent)]/30 bg-[var(--s-accent-soft)] text-[var(--s-text)]' : m.error ? 'border-[var(--s-crimson)]/30 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : 'border-[var(--s-border)] bg-[var(--s-surface)] text-[var(--s-text-secondary)]'}`}>
                  {m.role === 'assistant' && !m.error && m.content ? <ChatMarkdown content={m.content} /> : <div className="whitespace-pre-wrap break-words font-body text-[15px] leading-relaxed">{m.content}</div>}
                  {m.streaming && !m.error && <span className="mt-1 inline-block h-4 w-1 animate-pulse rounded-full bg-[var(--s-accent)] align-middle" />}
                  {m.ms !== undefined && <div className="mt-2 border-t border-[var(--s-divider)] pt-2 font-data text-[12px] text-[var(--s-text-muted)]">{m.ms} ms</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ── Composer ── */}
      <footer className="shrink-0 border-t border-[var(--s-divider)] bg-[color-mix(in_srgb,var(--s-bg)_86%,transparent)] p-3 backdrop-blur-xl sm:p-4">
        <div className="mx-auto max-w-4xl overflow-visible rounded-[12px] border border-[var(--s-border)] bg-[var(--s-surface)] shadow-[0_10px_40px_rgba(0,0,0,0.12)]">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={3}
            disabled={!canChat}
            className="max-h-[28dvh] min-h-[60px] w-full resize-none bg-transparent px-3 py-3 font-body text-[15px] text-[var(--s-text)] outline-none placeholder:text-[var(--s-text-subtle)] disabled:opacity-40"
            placeholder={canChat ? 'Message the model...' : `Chat unavailable — ${statusLabel.toLowerCase()}. ${nextStepHint(session.state, mode)}`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--s-divider)] px-2 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <button disabled title="File upload coming soon" className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--s-text-subtle)] opacity-50">
                <span className="i-ph:paperclip text-[17px]" />
              </button>
              <span className="truncate font-data text-[12px] font-semibold uppercase tracking-wide text-[var(--s-text-muted)]">
                {session.info?.model ?? (mode === 'dev' ? 'dev mode' : !canChat ? statusLabel : 'Loading model…')}
              </span>
            </div>
            {busy ? (
              <button onClick={stop} className="btn-secondary h-9 whitespace-nowrap"><span className="i-ph:stop text-[16px]" /> Stop</button>
            ) : (
              <button onClick={send} disabled={!canSend} className="btn-primary h-9 w-11 !px-0" title={canSend ? 'Send (Enter)' : 'Type a message first'}>
                <span className={busy ? 'i-ph:circle-notch animate-spin text-[18px]' : 'i-ph:paper-plane-tilt text-[18px]'} />
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

function nextStepHint(state: SessionState, mode: 'bridge' | 'dev'): string {
  if (mode === 'dev') return 'Running standalone — start the local dev server for simulated chat'
  switch (state) {
    case 'no-wallet': return 'Connect your wallet in Tangle Cloud'
    case 'no-operator': return 'Deploy an LLM Inference instance first'
    case 'needs-funding': return 'Fund your credits to unlock chat'
    case 'loading': return 'Connecting to operator…'
    default: return ''
  }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

function Gate({ session, mode, walletConnected, hasOperator, onFund, onStarter }: {
  session: ReturnType<typeof useInferenceSession>
  mode: 'bridge' | 'dev'
  walletConnected: boolean
  hasOperator: boolean
  onFund: () => void
  onStarter: (t: string) => void
}) {
  // Standalone dev mode
  if (mode === 'dev') {
    return (
      <Welcome
        icon="i-ph:flask"
        title="Standalone mode"
        body="This build runs inside Tangle Cloud. Open it from the dashboard to connect your wallet, deploy an instance, and chat with a real operator."
        color="amber"
      >
        {import.meta.env.DEV && (
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {STARTER_PROMPTS.map(p => <button key={p} onClick={() => onStarter(p)} className="min-h-[74px] rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] leading-relaxed text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]">{p}</button>)}
          </div>
        )}
      </Welcome>
    )
  }

  // No wallet
  if (session.state === 'no-wallet' || !walletConnected) {
    return <Welcome icon="i-ph:wallet" title="Connect your wallet" body="Your Tangle Cloud wallet connects automatically. If you see this, the connection may have dropped — try reopening this blueprint from the dashboard." color="amber" />
  }

  // No operator / no instance
  if (session.state === 'no-operator' || (!hasOperator && session.state !== 'error')) {
    return (
      <Welcome icon="i-ph:rocket-launch" title="No instance deployed" body="You need a service instance with an operator before you can chat. Deploy one from the LLM Inference blueprint page in Tangle Cloud." color="accent">
        <a href="/blueprints" className="btn-primary mt-5 h-10 px-5"><span className="i-ph:arrow-left text-[16px]" /> Back to blueprints</a>
      </Welcome>
    )
  }

  // Loading
  if (session.state === 'loading') {
    return <Welcome icon="i-ph:circle-notch" title="Connecting…" body={`Reaching operator ${session.operator ? shorten(session.operator.address) : ''}. Fetching model info and your credit balance.`} color="neutral" spin />
  }

  // Unconfigured
  if (session.state === 'unconfigured') {
    return <Welcome icon="i-ph:warning-circle" title="Operator not configured" body="This operator hasn't set up shielded credits billing. Inference can't be billed, so chat is disabled." color="amber" />
  }

  // Error
  if (session.state === 'error') {
    return <Welcome icon="i-ph:warning-circle" title="Connection failed" body={session.error ?? 'Unknown error.'} color="crimson" />
  }

  // Needs funding
  if (session.state === 'needs-funding') {
    return (
      <div className="w-full max-w-[480px] self-center pt-[clamp(32px,12dvh,112px)] text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[16px] bg-gradient-to-br from-[var(--s-accent)] to-[var(--s-brand)] shadow-[var(--s-glow-violet)]">
          <span className="i-ph:coins text-[24px] text-[var(--s-bg)]" />
        </span>
        <h2 className="mt-4 font-display text-[24px] font-semibold text-[var(--s-text)]">Fund your credits</h2>
        <p className="mt-2 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">Deposit tokens to unlock pay-per-token inference. Each request is authorized by an ephemeral key — the operator never sees your wallet address.</p>
        {session.info?.model && <p className="mt-2 font-data text-[13px] text-[var(--s-text-secondary)]">Model: {session.info.model}</p>}
        <button onClick={onFund} disabled={session.isFunding} className="btn-primary mt-5 h-11 px-6"><span className="i-ph:lightning text-[16px]" /> {session.isFunding ? 'Funding…' : 'Fund credits'}</button>
      </div>
    )
  }

  // Ready
  if (session.state === 'ready') {
    return (
      <div className="w-full max-w-[680px] self-center pt-[clamp(32px,12dvh,112px)]">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-[var(--s-emerald)]/35 bg-[var(--s-emerald-soft)] text-[var(--s-emerald)]">
            <span className="i-ph:sparkle text-[18px]" />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-[24px] font-semibold leading-tight text-[var(--s-text)]">Ready to chat</h2>
            <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">
              Streaming from <span className="text-[var(--s-text-secondary)]">{session.info?.model ?? 'operator model'}</span>. Billed against your prepaid credits.
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {STARTER_PROMPTS.map(p => <button key={p} onClick={() => onStarter(p)} className="min-h-[74px] rounded-[8px] border border-[var(--s-border)] bg-[var(--s-surface)] px-3 py-2 text-left font-data text-[13px] leading-relaxed text-[var(--s-text-secondary)] transition-colors hover:border-[var(--s-accent)]/45 hover:text-[var(--s-accent)]">{p}</button>)}
        </div>
      </div>
    )
  }

  return null
}

function Welcome({ icon, title, body, color, spin, children }: {
  icon: string; title: string; body: string; color: 'accent' | 'amber' | 'crimson' | 'neutral' | 'emerald'; spin?: boolean; children?: ReactNode
}) {
  const c = color === 'crimson' ? 'border-[var(--s-crimson)]/35 bg-[var(--s-crimson-soft)] text-[var(--s-crimson)]' : color === 'amber' ? 'border-[var(--s-amber)]/35 bg-[var(--s-amber-soft)] text-[var(--s-amber)]' : color === 'emerald' ? 'border-[var(--s-emerald)]/35 bg-[var(--s-emerald-soft)] text-[var(--s-emerald)]' : color === 'accent' ? 'border-[var(--s-accent)]/35 bg-[var(--s-accent-soft)] text-[var(--s-accent)]' : 'border-[var(--s-border)] bg-[var(--s-surface)] text-[var(--s-text-muted)]'
  return (
    <div className="w-full max-w-[680px] self-center pt-[clamp(32px,12dvh,112px)]">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border ${c} ${spin ? 'animate-spin' : ''}`}>
          <span className={`${icon} text-[18px]`} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-[24px] font-semibold leading-tight text-[var(--s-text)]">{title}</h2>
          <p className="mt-1 font-body text-[15px] leading-relaxed text-[var(--s-text-muted)]">{body}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function simulateStream(prompt: string, onDelta: (d: string) => void, onDone: () => void) {
  const canned = `You said: "${prompt}". Simulated stream — in production this comes from the operator's vLLM endpoint.`
  const tokens = canned.split(' '); let i = 0; let acc = ''
  const interval = setInterval(() => { if (i >= tokens.length) { clearInterval(interval); onDone(); return } acc += (i === 0 ? '' : ' ') + tokens[i]; i++; onDelta(acc) }, 40)
}
