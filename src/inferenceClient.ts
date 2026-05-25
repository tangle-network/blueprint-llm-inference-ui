// Operator HTTP client for LLM inference. This is the "rich app" half that
// the thin-iframe model leans on: the iframe talks DIRECTLY to the operator's
// HTTP endpoint for inference — no wallet, no parent round-trip, just fetch +
// streaming. The parent bridge is only for wallet/chain reads + (eventually)
// on-chain settlement.
//
// Operators expose an OpenAI-compatible `/v1/chat/completions` endpoint with
// SSE streaming. The iframe scopes requests to the connected wallet address
// (for per-account billing/rate-limits the operator enforces).

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type StreamHandlers = {
  onToken: (token: string) => void;
  onDone: (full: string) => void;
  onError: (error: Error) => void;
};

/**
 * Stream a chat completion from an operator's OpenAI-compatible endpoint.
 * Returns an abort function. Pure HTTP — works inside the sandboxed iframe
 * with no wallet involved; the `account` is passed as a header so the
 * operator can scope billing without the iframe holding any key.
 */
export function streamChatCompletion(args: {
  operatorRpcUrl: string;
  account: string | null;
  messages: ChatMessage[];
  model?: string;
  handlers: StreamHandlers;
}): () => void {
  const controller = new AbortController();
  const url = joinUrl(args.operatorRpcUrl, '/v1/chat/completions');

  (async () => {
    let accumulated = '';
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(args.account ? { 'x-tangle-account': args.account } : {}),
        },
        body: JSON.stringify({
          model: args.model ?? 'default',
          stream: true,
          messages: args.messages,
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `Operator responded ${response.status} ${response.statusText}`,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE frames: lines beginning `data: `.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            args.handlers.onDone(accumulated);
            return;
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const token = json.choices?.[0]?.delta?.content;
            if (token) {
              accumulated += token;
              args.handlers.onToken(token);
            }
          } catch {
            // Ignore malformed frames — operators occasionally send
            // keep-alive comments.
          }
        }
      }
      args.handlers.onDone(accumulated);
    } catch (err) {
      if (controller.signal.aborted) return;
      args.handlers.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  })();

  return () => controller.abort();
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}
