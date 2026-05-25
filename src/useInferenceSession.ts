import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildApproveTx,
  buildFundCreditsTx,
  createInferenceClient,
  createLocalSpendSigner,
  readCreditAccount,
  type EphemeralCreditIdentity,
  type InferenceClient,
  type OperatorInfo,
} from '@tangle-network/llm-inference-sdk'
import type { Address, Hex } from 'viem'
import {
  useChainContext,
  useTangleService,
  useTanglePublicClient,
  useTangleWallet,
} from '@tangle-network/blueprint-ui/iframe'

import { loadOrCreateCreditIdentity } from './creditIdentity'

/**
 * Operator self-description. The operator advertises its payment config so the
 * UI is fully self-configuring per operator — no hardcoded addresses. The
 * `shielded_credits` + `chain_id` fields are optional here because not every
 * deployed operator exposes them yet; we fall back to the chain context + a
 * build-time env for those.
 */
type OperatorPaymentInfo = OperatorInfo & {
  shielded_credits?: Address
  chain_id?: number
}

export type SessionState =
  | 'no-wallet'
  | 'no-operator'
  | 'loading'
  | 'unconfigured'
  | 'needs-funding'
  | 'ready'
  | 'error'

const ENV_SHIELDED_CREDITS = import.meta.env.VITE_SHIELDED_CREDITS_ADDRESS as
  | Address
  | undefined

export interface InferenceSession {
  state: SessionState
  error: string | null
  operator: { address: Address; rpcUrl: string } | null
  info: OperatorPaymentInfo | null
  balance: bigint | null
  commitment: Hex | null
  client: InferenceClient | null
  /** Deposit `amount` of the payment token into the credit account via the parent bridge. */
  fund: (amount: bigint) => Promise<void>
  refresh: () => Promise<void>
  isFunding: boolean
}

export function useInferenceSession(): InferenceSession {
  const wallet = useTangleWallet()
  const chain = useChainContext()
  const service = useTangleService()
  const publicClient = useTanglePublicClient()

  const [state, setState] = useState<SessionState>('no-wallet')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<OperatorPaymentInfo | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [isFunding, setIsFunding] = useState(false)
  const identityRef = useRef<EphemeralCreditIdentity | null>(null)
  const clientRef = useRef<InferenceClient | null>(null)

  // Active operator endpoint from the service-context broadcast.
  const operator = useMemo(() => {
    const op =
      service.operators.find((o) => o.status === 'active') ??
      service.operators[0]
    if (!op?.rpcAddress) return null
    return { address: op.address as Address, rpcUrl: op.rpcAddress }
  }, [service.operators])

  // Resolve the ShieldedCredits address + chain id (operator-advertised first).
  const shieldedCredits = info?.shielded_credits ?? ENV_SHIELDED_CREDITS ?? null
  const chainId = info?.chain_id ?? chain?.id ?? null
  const paymentToken = (info?.payment_token ?? null) as Address | null

  const refresh = useCallback(async () => {
    const identity = identityRef.current
    if (!publicClient || !shieldedCredits || !identity) return
    try {
      const account = await readCreditAccount(
        publicClient,
        shieldedCredits,
        identity.commitment,
      )
      setBalance(account.balance)
      clientRef.current?.setNonce(account.nonce)
    } catch {
      // account not yet funded → getAccount reverts/returns zero; treat as 0
      setBalance(0n)
    }
  }, [publicClient, shieldedCredits])

  // Build / rebuild the SDK client whenever the operator config is known.
  useEffect(() => {
    if (!wallet.isConnected || !wallet.address) {
      setState('no-wallet')
      return
    }
    if (!operator) {
      setState('no-operator')
      return
    }
    if (chainId === null) {
      setState('loading')
      return
    }

    let cancelled = false
    setState('loading')
    setError(null)

    const identity = loadOrCreateCreditIdentity(chainId)
    identityRef.current = identity

    ;(async () => {
      try {
        // Fetch operator self-description (model, pricing, payment config).
        const res = await fetch(`${operator.rpcUrl}/v1/operator`)
        if (!res.ok) throw new Error(`operator info ${res.status}`)
        const operatorInfo = (await res.json()) as OperatorPaymentInfo
        if (cancelled) return
        setInfo(operatorInfo)

        const sc = operatorInfo.shielded_credits ?? ENV_SHIELDED_CREDITS
        const cid = operatorInfo.chain_id ?? chainId
        if (!sc) {
          setState('unconfigured')
          return
        }

        clientRef.current = createInferenceClient({
          operatorUrl: operator.rpcUrl,
          shieldedCreditsAddress: sc,
          chainId: cid,
          commitment: identity.commitment,
          serviceId: BigInt(service.serviceId ?? 0),
          operatorAddress: operatorInfo.operator ?? operator.address,
          signer: createLocalSpendSigner(identity.spendingKeyPrivate),
          model: operatorInfo.model,
          pricePerInputToken: BigInt(
            operatorInfo.pricing?.price_per_input_token ?? 1,
          ),
          pricePerOutputToken: BigInt(
            operatorInfo.pricing?.price_per_output_token ?? 2,
          ),
        })

        await refresh()
        if (cancelled) return
        // The promotion effect demotes to 'needs-funding' if the balance is 0.
        setState('ready')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    wallet.isConnected,
    wallet.address,
    operator,
    chainId,
    service.serviceId,
    refresh,
  ])

  // Promote to ready / needs-funding as the balance arrives.
  useEffect(() => {
    if (state !== 'ready' && state !== 'needs-funding') return
    if (balance === null) return
    setState(balance > 0n ? 'ready' : 'needs-funding')
  }, [balance, state])

  const fund = useCallback(
    async (amount: bigint) => {
      const identity = identityRef.current
      if (!identity || !shieldedCredits || !paymentToken) {
        throw new Error('funding not configured')
      }
      setIsFunding(true)
      try {
        // 1. approve the ShieldedCredits contract to pull the payment token
        const approve = buildApproveTx({
          token: paymentToken,
          shieldedCreditsAddress: shieldedCredits,
          amount,
        })
        const approveHash = await wallet.sendTransaction({
          to: approve.to,
          data: approve.data,
          value: approve.value,
        })
        await publicClient?.waitForTransactionReceipt({ hash: approveHash })

        // 2. fund the credit account (binds commitment ↔ ephemeral spending key)
        const fundTx = buildFundCreditsTx({
          shieldedCreditsAddress: shieldedCredits,
          token: paymentToken,
          amount,
          commitment: identity.commitment,
          spendingKey: identity.spendingKey,
        })
        const fundHash = await wallet.sendTransaction({
          to: fundTx.to,
          data: fundTx.data,
          value: fundTx.value,
        })
        await publicClient?.waitForTransactionReceipt({ hash: fundHash })

        await refresh()
      } finally {
        setIsFunding(false)
      }
    },
    [wallet, publicClient, shieldedCredits, paymentToken, refresh],
  )

  return {
    state,
    error,
    operator,
    info,
    balance,
    commitment: identityRef.current?.commitment ?? null,
    client: clientRef.current,
    fund,
    refresh,
    isFunding,
  }
}
