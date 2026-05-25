import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TangleIframeProvider } from '@tangle-network/blueprint-ui/iframe'
import {
  TangleParentHarness,
  mockServiceContext,
  mockWallet,
  HARNESS_ORIGIN,
} from '@tangle-network/blueprint-ui/iframe/testing'

import { App } from './App'

/** Standalone dev mode — no harness, no parent. */
function renderDev() {
  return render(
    <TangleIframeProvider appId="llm-inference" mode="dev">
      <App />
    </TangleIframeProvider>,
  )
}

/** Embedded mode driven by the SDK's parent harness (no operator deployed). */
function renderEmbedded(opts?: { connected?: boolean }) {
  return render(
    <TangleParentHarness
      appId="llm-inference"
      wallet={mockWallet({
        address: opts?.connected === false ? null : undefined,
      })}
      service={mockServiceContext({ serviceId: '42', operators: [] })}
    >
      <TangleIframeProvider
        appId="llm-inference"
        mode="bridge"
        parentOrigin={HARNESS_ORIGIN}
      >
        <App />
      </TangleIframeProvider>
    </TangleParentHarness>,
  )
}

describe('LLM Inference blueprint UI', () => {
  it('dev mode streams a simulated reply without any wallet or operator', async () => {
    renderDev()
    expect(screen.getByText(/Inference-ready \(dev\)/i)).toBeTruthy()
    const textarea = screen.getByPlaceholderText(/Ask the model anything… \(dev\)/i)
    fireEvent.change(textarea, { target: { value: 'ping' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('ping')).toBeTruthy())
    await waitFor(
      () => expect(screen.getByText(/You said: "ping"/)).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('prompts to connect when embedded without a wallet', async () => {
    renderEmbedded({ connected: false })
    await waitFor(() =>
      expect(screen.getByText(/Connect your wallet/i)).toBeTruthy(),
    )
    expect(
      (screen.getByText('Send') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('shows the deploy-pending gate when no operator has deployed', async () => {
    renderEmbedded({ connected: true })
    await waitFor(() => expect(screen.getByText(/No operator yet/i)).toBeTruthy())
  })

  it('reflects the connected wallet address in the header', async () => {
    renderEmbedded({ connected: true })
    await waitFor(() => expect(screen.getByText(/0xd8dA…6045/i)).toBeTruthy())
  })
})
