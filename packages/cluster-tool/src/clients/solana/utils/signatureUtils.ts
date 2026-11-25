import Assert from "node:assert"

import type {
  ConfirmedSignatureInfo,
  Connection,
  Finality,
  PublicKey,
  VersionedTransactionResponse
} from "@solana/web3.js"
import { getLogger } from "@wireio/shared"
import { scaleTimeoutMs, sleep } from "../../../utils/asyncUtils.js"
import { SolanaClient } from "../SolanaClient.js"

const log = getLogger(__filename)

/** A failed history RPC, distinguished from invalid inputs or incomplete scans. */
export class SolanaHistoryRpcError extends Error {
  /**
   * Retain the RPC operation, account/signature and original transport error.
   * @param message - The failed request and its diagnostic message.
   * @param options - The original RPC error as the native error cause.
   */
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = SolanaHistoryRpcError.name
  }
}

/**
 * Page signatures newest first until the slot window is complete or its cap is exceeded.
 * @param getSignaturesForAddress - The connection's bound signature-page RPC.
 * @param address - Account whose transaction history is being read.
 * @param asOfSlot - Inclusive oldest slot; zero requests the entire retained history.
 * @param commitment - Required finality for every page.
 * @param maxPages - Maximum full pages before refusing an incomplete scan.
 * @returns All signatures in the completed window, newest first.
 * @throws SolanaHistoryRpcError for RPC failures; other errors for invalid inputs or a page cap.
 */
export async function readSignaturesSince(
  getSignaturesForAddress: Connection["getSignaturesForAddress"],
  address: PublicKey,
  asOfSlot = 0,
  commitment: Finality = SolanaClient.ConfirmationStatus.confirmed,
  maxPages = readSignaturesSince.MaxPages
): Promise<ConfirmedSignatureInfo[]> {
  Assert.ok(
    Number.isSafeInteger(asOfSlot) && asOfSlot >= 0,
    "History marker must be a slot"
  )
  Assert.ok(
    Number.isSafeInteger(maxPages) && maxPages > 0,
    "History page cap must be positive"
  )
  const signatures: ConfirmedSignatureInfo[] = []
  let before: string
  for (let pagesRead = 0; pagesRead < maxPages; pagesRead++) {
    const page = await getSignaturesForAddress(
        address,
        {
          limit: readSignaturesSince.PageSize,
          ...(before != null ? { before } : {})
        },
        commitment
      ).catch(error => {
        throw new SolanaHistoryRpcError(
          `getSignaturesForAddress(${address.toBase58()}, before=${before ?? "latest"}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }),
      firstBefore = page.findIndex(info => info.slot < asOfSlot)
    signatures.push(...(firstBefore < 0 ? page : page.slice(0, firstBefore)))
    if (firstBefore >= 0 || page.length < readSignaturesSince.PageSize)
      return signatures
    before = page[page.length - 1].signature
  }
  const message = `${address.toBase58()}'s history since slot ${asOfSlot} runs past ${maxPages} pages of ${readSignaturesSince.PageSize} signatures; narrow the history window or increase the page cap`
  log.debug(message)
  throw new Error(message)
}

export namespace readSignaturesSince {
  /** Solana's maximum signature page size; shared by all history readers. */
  export const PageSize = 1_000
  /** Default wallet-history cap; callers may select a smaller bounded window. */
  export const MaxPages = 50
}

/**
 * Read complete account history serially and return transactions oldest first.
 * @param connection - The destination RPC connection.
 * @param address - Account whose transaction history is being read.
 * @param commitment - Required finality for both signature and transaction reads.
 * @param maxPages - Maximum signature pages before refusing an incomplete scan.
 * @returns Complete transactions, or undefined for a missing transaction or metadata.
 * @throws SolanaHistoryRpcError only for a failed RPC; page-limit errors propagate separately.
 */
export async function readTransactionHistory(
  connection: Connection,
  address: PublicKey,
  commitment: Finality,
  maxPages: number
): Promise<VersionedTransactionResponse[]> {
  const signatures = await readSignaturesSince(
      connection.getSignaturesForAddress.bind(connection),
      address,
      0,
      commitment,
      maxPages
    ),
    transactions: VersionedTransactionResponse[] = []
  for (const { signature } of signatures.toReversed()) {
    const transaction = await connection
      .getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: 0
      })
      .catch(error => {
        throw new SolanaHistoryRpcError(
          `getTransaction(${signature}) for ${address.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      })
    if (!transaction?.meta) {
      log.debug(
        `History transaction or metadata unavailable: address=${address.toBase58()} signature=${signature}`
      )
      return undefined
    }
    transactions.push(transaction)
  }
  return transactions
}

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
 * confirmed/finalized WITHOUT an error, it reports an error (thrown at once: a
 * transaction the runtime processed with an error is still included in a
 * block, so it reaches those statuses too), or `deadlineMs` elapses (then
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
    {
      intervalMs = confirmSignature.DefaultIntervalMs,
      rpcTimeoutMs = confirmSignature.DefaultRpcTimeoutMs,
      rebroadcastMs = confirmSignature.DefaultRebroadcastMs
    } = options,
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

    // The error is checked FIRST: a transaction the runtime processed with an
    // error is still included in a block, so its status reaches `confirmed`
    // and `finalized` too, and returning on the status would report an
    // on-chain failure as success (flow-liq-yield run 4: a liqSOL deposit
    // refused by `EpochRewardsActive` passed as OK, and the next step found
    // the ATA it never created).
    if (txError)
      throw new Error(`${label} tx failed: ${JSON.stringify(txError)}`)
    if (
      confirmationStatus === SolanaClient.ConfirmationStatus.confirmed ||
      confirmationStatus === SolanaClient.ConfirmationStatus.finalized
    )
      return

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
