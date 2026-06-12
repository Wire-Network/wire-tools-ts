import type { Connection } from "@solana/web3.js"
import { log } from "../logger.js"
import { sleep } from "../util.js"

/**
 * Reject if `p` does not settle within `ms`. Bounds an otherwise-unbounded
 * network call so a hung/unresponsive peer cannot stall a polling deadline.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    )
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Options for {@link confirmSignature}. */
export interface ConfirmSignatureOptions {
  /** Overall confirmation budget before throwing. Default 60s. */
  deadlineMs?: number
  /** Delay between status polls. Default 500ms. */
  intervalMs?: number
  /** Per-RPC budget for each `getSignatureStatus` / rebroadcast call. Default 10s. */
  rpcTimeoutMs?: number
  /**
   * Optional re-submit callback, invoked every {@link ConfirmSignatureOptions.rebroadcastMs}
   * while the tx is still unconfirmed, to recover from a validator that
   * silently dropped it. ONLY safe when re-submission yields the SAME signature
   * being polled — i.e. `sendRawTransaction` of the identical signed bytes. Do
   * NOT pass `sendTransaction` / `requestAirdrop`: those re-sign / re-issue and
   * produce a NEW signature this poll would never observe.
   */
  rebroadcast?: () => Promise<unknown>
  /** How often to invoke `rebroadcast`. Default 5s. */
  rebroadcastMs?: number
}

const DEFAULT_DEADLINE_MS = 60_000
const DEFAULT_INTERVAL_MS = 500
const DEFAULT_RPC_TIMEOUT_MS = 10_000
const DEFAULT_REBROADCAST_MS = 5_000

/**
 * Poll `getSignatureStatus(sig)` until the transaction is confirmed/finalized,
 * it reports an error, or `deadlineMs` elapses (then throws).
 *
 * Each status RPC is bounded by `rpcTimeoutMs` via {@link withTimeout}: a hung
 * or unresponsive validator makes the individual poll reject rather than block
 * forever, so the `deadlineMs` budget is always honoured. An unbounded
 * `await connection.getSignatureStatus(sig)` is what let a transient
 * solana-test-validator stall turn into a multi-minute hang — the deadline is
 * only re-checked between polls, so a single stuck RPC defeated it entirely.
 *
 * @param connection Solana RPC connection.
 * @param sig        Signature to confirm.
 * @param label      Human-readable label for log/error messages.
 * @param opts       See {@link ConfirmSignatureOptions}.
 */
export async function confirmSignature(
  connection: Connection,
  sig: string,
  label: string,
  opts: ConfirmSignatureOptions = {}
): Promise<void> {
  const deadlineMs    = opts.deadlineMs    ?? DEFAULT_DEADLINE_MS
  const intervalMs    = opts.intervalMs    ?? DEFAULT_INTERVAL_MS
  const rpcTimeoutMs  = opts.rpcTimeoutMs  ?? DEFAULT_RPC_TIMEOUT_MS
  const rebroadcastMs = opts.rebroadcastMs ?? DEFAULT_REBROADCAST_MS

  const deadline = Date.now() + deadlineMs
  let pollCount = 0
  let lastRebroadcast = Date.now()

  while (Date.now() < deadline) {
    let conf: string | null | undefined
    let err: unknown
    try {
      const status = await withTimeout(
        connection.getSignatureStatus(sig),
        rpcTimeoutMs,
        `${label} getSignatureStatus`
      )
      conf = status?.value?.confirmationStatus
      err  = status?.value?.err
    } catch (e) {
      // Slow/hung status RPC: keep polling so the deadline is still enforced.
      if (pollCount % 10 === 0)
        log.warn(`[confirmSignature/${label}] status RPC unavailable: ${String(e)}`)
    }
    if (pollCount % 10 === 0)
      log.info(
        `[confirmSignature/${label}] poll #${pollCount} conf=${conf} err=${JSON.stringify(err)}`
      )
    pollCount++

    if (conf === "confirmed" || conf === "finalized") return
    if (err) throw new Error(`${label} tx failed: ${JSON.stringify(err)}`)

    if (opts.rebroadcast && Date.now() - lastRebroadcast >= rebroadcastMs) {
      await withTimeout(
        Promise.resolve(opts.rebroadcast()),
        rpcTimeoutMs,
        `${label} rebroadcast`
      ).catch(e =>
        log.warn(`[confirmSignature/${label}] rebroadcast failed: ${String(e)}`)
      )
      lastRebroadcast = Date.now()
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} tx ${sig} not confirmed within ${deadlineMs}ms`)
}
