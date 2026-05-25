import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TangleIframeProvider } from '@tangle-network/blueprint-ui/iframe';
import {
  TangleParentHarness,
  mockServiceContext,
  mockWallet,
  HARNESS_ORIGIN,
} from '@tangle-network/blueprint-ui/iframe/testing';

import { App } from './App';

/**
 * Full end-to-end render of the reference blueprint against the SDK's parent
 * harness — no Tangle Cloud dapp, no wallet extension, no chain. This is the
 * promise of the SDK made concrete: a blueprint is testable in isolation,
 * inheriting wallet + chain + service context purely over the bridge.
 */
function renderEmbedded(opts?: {
  connected?: boolean;
  serviceId?: string | null;
}) {
  return render(
    <TangleParentHarness
      appId="llm-inference"
      wallet={mockWallet({
        address: opts?.connected === false ? null : undefined,
      })}
      service={mockServiceContext({ serviceId: opts?.serviceId ?? '42' })}
    >
      <TangleIframeProvider
        appId="llm-inference"
        mode="bridge"
        parentOrigin={HARNESS_ORIGIN}
      >
        <App />
      </TangleIframeProvider>
    </TangleParentHarness>,
  );
}

/**
 * Build a Response whose body streams OpenAI-style SSE frames, one chunk per
 * `enqueue`, terminated by `[DONE]`. This is exactly the wire shape an
 * operator emits, so the test exercises inferenceClient's real SSE parser.
 */
function sseResponse(tokens: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const t of tokens) {
        const frame = `data: ${JSON.stringify({
          choices: [{ delta: { content: t } }],
        })}\n\n`;
        controller.enqueue(encoder.encode(frame));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LLM Inference blueprint (embedded)', () => {
  it('renders the wallet address from the parent bridge', async () => {
    renderEmbedded();
    await waitFor(() => {
      expect(screen.getByText(/0xd8dA…6045/i)).toBeTruthy();
    });
  });

  it('shows the chain name injected via serviceContext', async () => {
    renderEmbedded();
    await waitFor(() => {
      expect(screen.getByText('Base Sepolia')).toBeTruthy();
    });
  });

  it('shows the service id from the broadcast', async () => {
    renderEmbedded({ serviceId: '99' });
    await waitFor(() => {
      expect(screen.getByText('99')).toBeTruthy();
    });
  });

  it('streams an operator reply token-by-token over SSE', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(sseResponse(['Hello', ', ', 'world', '!']));

    renderEmbedded();
    // findBy waits for the wallet to connect (placeholder flips once the
    // bridge delivers the account).
    const textarea = await screen.findByPlaceholderText(/Ask the model/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    const send = screen.getByText('Send') as HTMLButtonElement;
    // Send enables once a draft exists AND the operator has arrived over the
    // bridge (canSend gates on operator.rpcAddress).
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);

    // User bubble appears immediately.
    await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
    // Streamed tokens accumulate into the assistant bubble.
    await waitFor(() =>
      expect(screen.getByText('Hello, world!')).toBeTruthy(),
    );

    // The operator endpoint was hit with the connected account header.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('http://localhost:8545/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-tangle-account']).toBe(
      '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    );
  });

  it('surfaces an operator error in the assistant bubble', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
    );

    renderEmbedded();
    const textarea = await screen.findByPlaceholderText(/Ask the model/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    const send = screen.getByText('Send') as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() =>
      expect(screen.getByText(/Operator responded 503/i)).toBeTruthy(),
    );
  });

  it('prompts to connect when no wallet is present', async () => {
    renderEmbedded({ connected: false });
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Connect a wallet in Tangle Cloud/i),
      ).toBeTruthy();
    });
  });
});
