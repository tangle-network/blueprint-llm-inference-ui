import { useCallback, useMemo, useRef, useState } from 'react';
import {
  useChainContext,
  useTangleMode,
  useTangleService,
  useTanglePublicClient,
  useTangleWallet,
} from '@tangle-network/blueprint-ui/iframe';

import {
  streamChatCompletion,
  type ChatMessage,
} from './inferenceClient';

type ThreadMessage = ChatMessage & { id: string; streaming?: boolean };

let messageCounter = 0;
const nextId = () => `m${messageCounter++}`;

export function App() {
  const mode = useTangleMode();
  const wallet = useTangleWallet();
  const service = useTangleService();
  const chain = useChainContext();
  const publicClient = useTanglePublicClient();

  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  // Active operator: first active one from the broadcast service context.
  // The iframe never picks operators for signing — the parent's quote
  // logic does that — but for READ-path inference the iframe talks to an
  // operator's HTTP endpoint directly.
  const operator = useMemo(
    () =>
      service.operators.find((o) => o.status === 'active') ??
      service.operators[0] ??
      null,
    [service.operators],
  );

  const canSend =
    !isStreaming &&
    draft.trim().length > 0 &&
    (operator?.rpcAddress != null || mode === 'dev');

  const send = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt) return;
    const userMsg: ThreadMessage = {
      id: nextId(),
      role: 'user',
      content: prompt,
    };
    const assistantMsg: ThreadMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const baseThread = [...thread, userMsg];
    setThread([...baseThread, assistantMsg]);
    setDraft('');
    setIsStreaming(true);

    // Dev mode without a real operator → echo a canned stream so the UI is
    // iterable standalone. Production hits the operator endpoint.
    const rpcUrl = operator?.rpcAddress;
    if (!rpcUrl) {
      simulateStream(assistantMsg.id, prompt, setThread, () =>
        setIsStreaming(false),
      );
      return;
    }

    abortRef.current = streamChatCompletion({
      operatorRpcUrl: rpcUrl,
      account: wallet.address,
      messages: baseThread.map(({ role, content }) => ({ role, content })),
      handlers: {
        onToken: (token) => {
          setThread((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: m.content + token }
                : m,
            ),
          );
        },
        onDone: () => {
          setThread((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, streaming: false } : m,
            ),
          );
          setIsStreaming(false);
        },
        onError: (error) => {
          setThread((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? {
                    ...m,
                    streaming: false,
                    content:
                      m.content || `⚠️ ${error.message}`,
                  }
                : m,
            ),
          );
          setIsStreaming(false);
        },
      },
    });
  }, [draft, thread, operator, wallet.address]);

  const stop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setIsStreaming(false);
    setThread((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
  }, []);

  return (
    <div className="app">
      <Header
        mode={mode}
        walletAddress={wallet.address}
        chainName={chain?.name ?? null}
        serviceId={service.serviceId}
        operator={operator}
        hasPublicClient={publicClient !== null}
      />

      <main className="thread" aria-live="polite">
        {thread.length === 0 ? (
          <EmptyThread connected={wallet.isConnected} />
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
              e.preventDefault();
              if (canSend) send();
            }
          }}
          placeholder={
            wallet.isConnected
              ? 'Ask the model anything…'
              : 'Connect a wallet in Tangle Cloud to start'
          }
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
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function Header({
  mode,
  walletAddress,
  chainName,
  serviceId,
  operator,
  hasPublicClient,
}: {
  mode: 'bridge' | 'dev';
  walletAddress: string | null;
  chainName: string | null;
  serviceId: string | null;
  operator: { address: string; status: string } | null;
  hasPublicClient: boolean;
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
        <Stat label="Chain" value={chainName ?? '—'} tone={chainName ? 'ok' : 'muted'} />
        <Stat
          label="Service"
          value={serviceId ?? 'Not deployed'}
          tone={serviceId ? 'ok' : 'muted'}
        />
        <Stat
          label="Operator"
          value={operator ? shorten(operator.address) : 'None'}
          tone={operator?.status === 'active' ? 'ok' : 'muted'}
        />
        <Stat
          label="RPC client"
          value={hasPublicClient ? 'Ready' : 'Pending'}
          tone={hasPublicClient ? 'ok' : 'muted'}
        />
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'muted';
}) {
  return (
    <div className={`stat ${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function EmptyThread({ connected }: { connected: boolean }) {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden>
        ◆
      </div>
      <h2>Inference-ready</h2>
      <p>
        {connected
          ? 'Send a prompt — it streams straight from the operator. No transaction needed to chat; settlement happens on-chain when you choose.'
          : 'This blueprint inherits the wallet you connected in Tangle Cloud. Connect there to begin.'}
      </p>
    </div>
  );
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
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/**
 * Dev-mode canned stream so the UI is iterable standalone (no operator).
 * Production never hits this — it's the same code path the dev harness
 * exercises.
 */
function simulateStream(
  messageId: string,
  prompt: string,
  setThread: React.Dispatch<React.SetStateAction<ThreadMessage[]>>,
  onDone: () => void,
) {
  const canned =
    `You said: "${prompt}". This is a simulated stream — in production ` +
    `these tokens come from the operator's inference endpoint over SSE. ` +
    `The thin-iframe SDK gave this app the wallet + chain + operator ` +
    `context with zero wallet code.`;
  const tokens = canned.split(' ');
  let i = 0;
  const interval = setInterval(() => {
    if (i >= tokens.length) {
      clearInterval(interval);
      setThread((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, streaming: false } : m)),
      );
      onDone();
      return;
    }
    const token = (i === 0 ? '' : ' ') + tokens[i];
    i += 1;
    setThread((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, content: m.content + token } : m,
      ),
    );
  }, 40);
}
