import type { Connection } from "@solana/web3.js"
import { getLogger } from "@wireio/shared"
import { scaleTimeoutMs, sleep } from "../../../utils/asyncUtils.js"
import { SolanaClient } from "../SolanaClient.js"

const log = getLogger("signatureUtils")

/**
 * Reject if `promise` does not settle within `ms`. Bounds an otherwise-unbounded
 * network call so a hung peer cannot stall a polling deadline.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer)
  })
}

/** Options for {@link confirmSignature}. */
export interface ConfirmSignatureOptions {
  /** Overall confirmation budget before throwing. */
  deadlineMs?: number
  /** Delay between status polls. */
  intervalMs?: number
  /** Per-RPC budget for each `getSignatureStatus` / rebroadcast call. */
  rpcTimeoutMs?: number
  /**
   * Optional re-submit callback, invoked every {@link ConfirmSignatureOptions.rebroadcastMs}
   * while the transaction is still unconfirmed. ONLY safe when re-submission
   * yields the SAME signature being polled (`sendRawTransaction` of the
   * identical signed bytes) — NOT `sendTransaction` / `requestAirdrop`, which
   * re-sign and produce a new signature this poll would never observe.
   */
  rebroadcast?: () => Promise<unknown>
  /** How often to invoke `rebroadcast`. */
  rebroadcastMs?: number
}

/**
 * Poll `getSignatureStatus(signature)` until the transaction is
 * confirmed/finalized, it reports an error, or `deadlineMs` elapses (then
 * throws). Each status RPC is bounded by `rpcTimeoutMs` via {@link withTimeout}
 * so a hung validator makes the individual poll reject rather than block
 * forever — the deadline budget is always honoured.
 *
 * @param connection - Solana RPC connection.
 * @param signature - Signature to confirm.
 * @param label - Human-readable label for log / error messages.
 * @param options - See {@link ConfirmSignatureOptions}.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  label: string,
  options: ConfirmSignatureOptions = {}
): Promise<void> {
  // Confirmation deadlines are calibrated wall-clock constants — the flow
  // timing scale stretches them uniformly (a starved shared-host validator
  // legitimately confirms slower; see utils/asyncUtils.FlowTimeoutScaleEnvVar).
  const deadlineMs = scaleTimeoutMs(
      options.deadlineMs ?? confirmSignature.DefaultDeadlineMs
    ),
    intervalMs = options.intervalMs ?? confirmSignature.DefaultIntervalMs,
    rpcTimeoutMs = options.rpcTimeoutMs ?? confirmSignature.DefaultRpcTimeoutMs,
    rebroadcastMs =
      options.rebroadcastMs ?? confirmSignature.DefaultRebroadcastMs,
    deadline = Date.now() + deadlineMs
  let pollCount = 0
  let lastRebroadcast = Date.now()

  while (Date.now() < deadline) {
    let confirmationStatus: string | null = null
    let txError: unknown
    try {
      const status = await withTimeout(
        connection.getSignatureStatus(signature),
        rpcTimeoutMs,
        `${label} getSignatureStatus`
      )
      confirmationStatus = status?.value?.confirmationStatus
      txError = status?.value?.err
    } catch (error) {
      // Slow/hung status RPC: keep polling so the deadline is still enforced.
      if (pollCount % confirmSignature.LogEveryNthPoll === 0)
        log.warn(
          `[confirmSignature/${label}] status RPC unavailable: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    if (pollCount % confirmSignature.LogEveryNthPoll === 0)
      log.info(
        `[confirmSignature/${label}] poll #${pollCount} status=${confirmationStatus} err=${JSON.stringify(txError)}`
      )
    pollCount++

    if (
      confirmationStatus === SolanaClient.ConfirmationStatus.confirmed ||
      confirmationStatus === SolanaClient.ConfirmationStatus.finalized
    )
      return
    if (txError) throw new Error(`${label} tx failed: ${JSON.stringify(txError)}`)

    if (options.rebroadcast && Date.now() - lastRebroadcast >= rebroadcastMs) {
      await withTimeout(
        Promise.resolve(options.rebroadcast()),
        rpcTimeoutMs,
        `${label} rebroadcast`
      ).catch(error =>
        log.warn(
          `[confirmSignature/${label}] rebroadcast failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      lastRebroadcast = Date.now()
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `${label} tx ${signature} not confirmed within ${deadlineMs}ms`
  )
}

export namespace confirmSignature {
  export const DefaultDeadlineMs = 120_000
  export const DefaultIntervalMs = 500
  export const DefaultRpcTimeoutMs = 10_000
  export const DefaultRebroadcastMs = 5_000
  /** Log the poll line every Nth poll (keeps a long confirm from spamming). */
  export const LogEveryNthPoll = 10
}
