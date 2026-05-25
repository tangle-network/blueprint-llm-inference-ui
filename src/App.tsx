import { useCallback, useRef, useState } from 'react'
import { useTangleMode, useTangleWallet } from '@tangle-network/blueprint-ui/iframe'

import { useInferenceSession, type SessionState } from './useInferenceSession'

interface ThreadMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

let messageCounter = 0
const nextId = () => `m${messageCounter++}`

// A modest default deposit (raw token units). The operator advertises pricing;
// this funds enough for many requests at the example 1/2 wei-per-token rates.
const DEFAULT_FUND_AMOUNT = 1_000_000_000_000_000_000n

export function App() {
  const mode = useTangleMode()
  const wallet = useTangleWallet()
  const session = useInferenceSession()

  const [thread, setThread] = useState<ThreadMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<(() => void) | null>(null)

  // Real inference requires a ready session. The dev simulate path is only
  // available when running the local dev server — a production build must
  // never fake a stream, even if opened standalone (mode would be 'dev').
  const canChat = session.state === 'ready' || (mode === 'dev' && import.meta.env.DEV)
  const canSend = !isStreaming && draft.trim().length > 0 && canChat

  const send = useCallback(() => {
    const prompt = draft.trim()
    if (!prompt) return
    const userMsg: ThreadMessage = { id: nextId(), role: 'user', content: prompt }
    const assistantMsg: ThreadMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      streaming: true,
    }
    const history = [...thread, userMsg]
    setThread([...history, assistantMsg])
    setDraft('')
    setIsStreaming(true)

    const patch = (content: string, streaming: boolean) =>
      setThread((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, content, streaming } : m,
        ),
      )

    // Local dev only: canned stream so the UI is iterable without an operator.
    // Never reachable in a production build (canChat gates it off).
    if (!session.client) {
      if (import.meta.env.DEV) {
        simulateStream(prompt, patch, () => setIsStreaming(false))
      } else {
        setIsStreaming(false)
      }
      return
    }

    abortRef.current = session.client.chatStream(
      history.map(({ role, content }) => ({ role, content })),
      {
        onToken: ({ accumulated }) => patch(accumulated, true),
        onDone: (full) => {
          patch(full, false)
          setIsStreaming(false)
        },
        onError: (err) => {
          patch(`⚠️ ${err.message}`, false)
          setIsStreaming(false)
        },
      },
    )
  }, [draft, thread, session.client])

  const stop = useCallback(() => {
    abortRef.current?.()
    abortRef.current = null
    setIsStreaming(false)
    setThread((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    )
  }, [])

  const fund = useCallback(() => {
    session.fund(DEFAULT_FUND_AMOUNT).catch(() => {
      /* surfaced via session.error */
    })
  }, [session])

  return (
    <div className="app">
      <Header
        mode={mode}
        walletAddress={wallet.address}
        model={session.info?.model ?? null}
        operator={session.operator?.address ?? null}
        balance={session.balance}
        state={session.state}
      />

      <main className="thread" aria-live="polite">
        {thread.length === 0 ? (
          <Gate session={session} mode={mode} onFund={fund} />
        ) : (
          thread.map((m) => <Bubble key={m.id} message={m} />)
        )}
      </main>

      <footer className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) send()
            }
          }}
          placeholder={composerPlaceholder(session.state, mode)}
          rows={2}
        />
        {isStreaming ? (
          <button type="button" className="stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="send"
            onClick={send}
            disabled={!canSend}
          >
            Send
          </button>
        )}
      </footer>
    </div>
  )
}

function composerPlaceholder(state: SessionState, mode: 'bridge' | 'dev'): string {
  if (mode === 'dev') return 'Ask the model anything… (dev)'
  switch (state) {
    case 'no-wallet':
      return 'Connect a wallet in Tangle Cloud to start'
    case 'no-operator':
      return 'No operator has deployed this service yet'
    case 'needs-funding':
      return 'Fund credits to start chatting'
    case 'ready':
      return 'Ask the model anything…'
    default:
      return 'Preparing inference session…'
  }
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function Header({
  mode,
  walletAddress,
  model,
  operator,
  balance,
  state,
}: {
  mode: 'bridge' | 'dev'
  walletAddress: string | null
  model: string | null
  operator: string | null
  balance: bigint | null
  state: SessionState
}) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>
          ◆
        </span>
        <h1>LLM Inference</h1>
        {mode === 'dev' && <span className="pill dev">dev</span>}
      </div>
      <div className="status-row">
        <Stat
          label="Wallet"
          value={walletAddress ? shorten(walletAddress) : 'Not connected'}
          tone={walletAddress ? 'ok' : 'warn'}
        />
        <Stat label="Model" value={model ?? '—'} tone={model ? 'ok' : 'muted'} />
        <Stat
          label="Operator"
          value={operator ? shorten(operator) : 'None'}
          tone={operator ? 'ok' : 'muted'}
        />
        <Stat
          label="Credits"
          value={balance === null ? '—' : balance.toString()}
          tone={balance && balance > 0n ? 'ok' : 'muted'}
        />
        <Stat label="Status" value={state} tone={stateTone(state)} />
      </div>
    </header>
  )
}

function stateTone(state: SessionState): 'ok' | 'warn' | 'muted' {
  if (state === 'ready') return 'ok'
  if (state === 'error' || state === 'unconfigured') return 'warn'
  return 'muted'
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'ok' | 'warn' | 'muted'
}) {
  return (
    <div className={`stat ${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

function Gate({
  session,
  mode,
  onFund,
}: {
  session: ReturnType<typeof useInferenceSession>
  mode: 'bridge' | 'dev'
  onFund: () => void
}) {
  if (mode === 'dev') {
    return (
      <Empty
        title="Inference-ready (dev)"
        body="Standalone dev mode — send a prompt for a simulated stream. Embedded in Tangle Cloud, this same build inherits the wallet, signs SpendAuths locally, and streams from a real operator."
      />
    )
  }
  switch (session.state) {
    case 'no-wallet':
      return (
        <Empty
          title="Connect your wallet"
          body="This blueprint inherits the wallet you connected in Tangle Cloud. Connect there to begin."
        />
      )
    case 'no-operator':
      return (
        <Empty
          title="No operator yet"
          body="No operator has deployed an instance of this service. Once one is live, inference becomes available here."
        />
      )
    case 'loading':
      return <Empty title="Preparing…" body="Fetching operator info and your credit account." />
    case 'unconfigured':
      return (
        <Empty
          title="Operator not configured for payments"
          body="This operator did not advertise a ShieldedCredits contract, so credits can't be funded from here."
        />
      )
    case 'error':
      return <Empty title="Something went wrong" body={session.error ?? 'Unknown error.'} />
    case 'needs-funding':
      return (
        <div className="empty">
          <div className="empty-glyph" aria-hidden>
            ◆
          </div>
          <h2>Fund anonymous credits</h2>
          <p>
            Deposit once into a shielded credit account, then chat with no
            per-message transaction. Each request is authorized by an ephemeral
            key signed locally — the operator never learns who you are.
          </p>
          <button
            type="button"
            className="send"
            onClick={onFund}
            disabled={session.isFunding}
          >
            {session.isFunding ? 'Funding…' : 'Fund credits'}
          </button>
        </div>
      )
    case 'ready':
      return (
        <Empty
          title="Inference-ready"
          body="Send a prompt — it streams straight from the operator, billed against your prepaid credits. No transaction per message."
        />
      )
  }
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden>
        ◆
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  )
}

function Bubble({ message }: { message: ThreadMessage }) {
  return (
    <div className={`bubble ${message.role}`}>
      <div className="bubble-role">{message.role}</div>
      <div className="bubble-content">
        {message.content}
        {message.streaming && <span className="caret" aria-hidden />}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function simulateStream(
  prompt: string,
  patch: (content: string, streaming: boolean) => void,
  onDone: () => void,
) {
  const canned =
    `You said: "${prompt}". This is a simulated stream — in production these ` +
    `tokens come from the operator's vLLM endpoint over SSE, billed against ` +
    `prepaid shielded credits. The SpendAuth is signed locally by an ephemeral ` +
    `key; only funding touches your real wallet, through the Tangle bridge.`
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
