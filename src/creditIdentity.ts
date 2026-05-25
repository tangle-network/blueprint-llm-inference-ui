import {
  creditIdentityFromKey,
  generateCreditIdentity,
  type EphemeralCreditIdentity,
} from '@tangle-network/llm-inference-sdk'
import type { Hex } from 'viem'

/**
 * The ephemeral spending key + commitment are persisted client-side so the
 * same credit account survives reloads. In the sandboxed iframe, localStorage
 * is provided by the host's inline shim (see index.html). The key never leaves
 * the iframe and never touches the user's real wallet — funding is a separate
 * on-chain step routed through the parent bridge.
 *
 * Keyed by chain id so switching networks uses a distinct credit account.
 */
const STORAGE_PREFIX = 'tangle.llm-inference.credit.'

interface PersistedIdentity {
  spendingKeyPrivate: Hex
  salt: Hex
}

function storageKey(chainId: number): string {
  return `${STORAGE_PREFIX}${chainId}`
}

function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // sandboxed without the shim — identity is in-memory for this session only
  }
}

/** Load the persisted credit identity for a chain, or create + persist a new one. */
export function loadOrCreateCreditIdentity(
  chainId: number,
): EphemeralCreditIdentity {
  const raw = safeGet(storageKey(chainId))
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedIdentity
      if (parsed.spendingKeyPrivate && parsed.salt) {
        return creditIdentityFromKey(parsed.spendingKeyPrivate, parsed.salt)
      }
    } catch {
      // corrupt entry — fall through and regenerate
    }
  }
  const identity = generateCreditIdentity()
  const toPersist: PersistedIdentity = {
    spendingKeyPrivate: identity.spendingKeyPrivate,
    salt: identity.salt,
  }
  safeSet(storageKey(chainId), JSON.stringify(toPersist))
  return identity
}
