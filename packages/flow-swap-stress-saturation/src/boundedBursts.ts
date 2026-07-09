import { ethers } from "ethers"

import { EthereumBurstDefaults } from "./ethereumBurstDefaults.js"

/** Single ETH-source swap request in a stress burst. */
export type EthereumBurstSwapRequest = {
  /** Stable burst index used for telemetry. */
  readonly index: number
  /** Source token slug_name as bigint. */
  readonly sourceTokenCode: bigint
  /** Source reserve slug_name as bigint. */
  readonly sourceReserveCode: bigint
  /** Native ETH source amount in wei. */
  readonly sourceAmountWei: bigint
  /** Target chain slug_name as bigint. */
  readonly targetChainCode: bigint
  /** Target token slug_name as bigint. */
  readonly targetTokenCode: bigint
  /** Target reserve slug_name as bigint. */
  readonly targetReserveCode: bigint
  /** Raw target recipient bytes. */
  readonly targetRecipient: Uint8Array
  /** Minimum destination amount. */
  readonly targetAmount: bigint
  /** Variance tolerance in basis points. */
  readonly targetToleranceBps: number
}

/** Minimal mined receipt shape captured from an Ethereum tx. */
export type EthereumBurstReceipt = {
  /** Receipt status from the EVM transaction. */
  readonly status: number | null
  /** Mined transaction hash. */
  readonly hash: string
  /** Block number containing the transaction. */
  readonly blockNumber: number
  /** Cumulative gas used by the transaction. */
  readonly gasUsed: bigint
}

/** Minimal transaction response shape required by ETH burst submission. */
export type EthereumBurstTransaction = {
  /** Wait for the transaction receipt. */
  readonly wait: (
    confirmations?: number
  ) => Promise<EthereumBurstReceipt | null>
}

/** Mockable ReserveManager requestSwap surface for ETH bursts. */
export type EthereumBurstReserveManager = {
  /** Submit a native ETH requestSwap call with explicit nonce override. */
  readonly requestSwap: (
    sourceTokenCode: bigint,
    sourceReserveCode: bigint,
    targetChainCode: bigint,
    targetTokenCode: bigint,
    targetReserveCode: bigint,
    targetRecipient: Uint8Array,
    targetAmount: bigint,
    targetToleranceBps: number,
    overrides: ethers.Overrides & {
      readonly value: bigint
      readonly nonce: number
    }
  ) => Promise<EthereumBurstTransaction>
}

/** Successful burst submission telemetry. */
export type BurstSuccess = {
  /** Stable request index. */
  readonly index: number
  /** Explicit nonce for ETH submissions, or null for Solana/SPL submissions. */
  readonly nonce: number | null
  /** Transaction hash or Solana signature. */
  readonly id: string
  /** Block number for ETH, or null for Solana/SPL. */
  readonly blockNumber: number | null
  /** Gas used for ETH, or null for Solana/SPL. */
  readonly gasUsed: bigint | null
}

/** Failed burst submission telemetry. */
export type BurstFailure = {
  /** Stable request index. */
  readonly index: number
  /** Explicit nonce for ETH submissions, or null for Solana/SPL submissions. */
  readonly nonce: number | null
  /** Error message captured without throwing away the rest of the burst. */
  readonly reason: string
}

/** Bounded burst telemetry returned to the iteration classifier. */
export type BurstResult = {
  /** Successful request submissions. */
  readonly successes: readonly BurstSuccess[]
  /** Failed request submissions; any entry classifies the iteration as breakage. */
  readonly failures: readonly BurstFailure[]
}

/** Options for native ETH burst submission. */
export type EthereumBurstOptions = {
  /** ReserveManager surface bound to the source wallet. */
  readonly reserveManager: EthereumBurstReserveManager
  /** Requests to submit. */
  readonly requests: readonly EthereumBurstSwapRequest[]
  /** First nonce allocated to this burst. */
  readonly firstNonce: number
  /** Max in-flight Ethereum transactions. */
  readonly concurrency: number
}

/** Solana/SPL request wrapper used by the inverse-route burst helper. */
export type SolanaBurstRequest<Request> = {
  /** Stable request index. */
  readonly index: number
  /** Route-specific Solana or SPL request payload. */
  readonly request: Request
}

/** Options for bounded Solana/SPL or inverse route submission. */
export type SolanaBurstOptions<Request> = {
  /** Requests to submit. */
  readonly requests: readonly SolanaBurstRequest<Request>[]
  /** Max in-flight Solana/SPL transactions. */
  readonly concurrency: number
  /** Route-specific submitter returning a confirmed signature. */
  readonly submit: (request: SolanaBurstRequest<Request>) => Promise<string>
}

type BurstItemResult =
  | { readonly kind: "success"; readonly success: BurstSuccess }
  | { readonly kind: "failure"; readonly failure: BurstFailure }

/**
 * Allocate contiguous Ethereum nonces for one burst.
 *
 * @param firstNonce First nonce returned by the provider before the burst.
 * @param count Number of transactions that will be submitted.
 * @returns Contiguous nonce list in request order.
 */
export function allocateContiguousNonces(
  firstNonce: number,
  count: number
): readonly number[] {
  assertPositiveInteger(count, "nonce count")
  return Array.from({ length: count }, (_value, index) => firstNonce + index)
}

/**
 * Submit an ETH-source burst with explicit nonce allocation and bounded fanout.
 *
 * @param options ReserveManager, requests, first nonce, and concurrency bound.
 * @returns Per-request success/failure telemetry.
 */
export async function runEthereumSwapBurst(
  options: EthereumBurstOptions
): Promise<BurstResult> {
  assertPositiveInteger(options.concurrency, "ETH burst concurrency")
  const nonces = allocateContiguousNonces(
      options.firstNonce,
      options.requests.length
    ),
    results = await runBounded(options.requests, options.concurrency, request =>
      submitEthereumRequest(
        options.reserveManager,
        request,
        nonces[request.index] ?? options.firstNonce
      )
    )
  return collectBurstResults(results)
}

/**
 * Submit a Solana/SPL or inverse-route burst with bounded fanout.
 *
 * @param options Requests, route submitter, and concurrency bound.
 * @returns Per-request success/failure telemetry.
 */
export async function runSolanaSwapBurst<Request>(
  options: SolanaBurstOptions<Request>
): Promise<BurstResult> {
  assertPositiveInteger(options.concurrency, "Solana burst concurrency")
  const results = await runBounded(
    options.requests,
    options.concurrency,
    request => submitSolanaRequest(options.submit, request)
  )
  return collectBurstResults(results)
}

async function submitEthereumRequest(
  reserveManager: EthereumBurstReserveManager,
  request: EthereumBurstSwapRequest,
  nonce: number
): Promise<BurstItemResult> {
  try {
    const tx = await reserveManager.requestSwap(
        request.sourceTokenCode,
        request.sourceReserveCode,
        request.targetChainCode,
        request.targetTokenCode,
        request.targetReserveCode,
        request.targetRecipient,
        request.targetAmount,
        request.targetToleranceBps,
        {
          value: request.sourceAmountWei,
          nonce,
          gasLimit: EthereumBurstDefaults.RequestSwapGasLimit
        }
      ),
      receipt = await tx.wait(1)
    if (receipt === null || receipt.status !== 1) {
      return failure(
        request.index,
        nonce,
        `receipt status ${receipt?.status ?? "null"}`
      )
    }
    return {
      kind: "success",
      success: {
        index: request.index,
        nonce,
        id: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed
      }
    }
  } catch (error) {
    return failure(request.index, nonce, formatError(error))
  }
}

async function submitSolanaRequest<Request>(
  submit: (request: SolanaBurstRequest<Request>) => Promise<string>,
  request: SolanaBurstRequest<Request>
): Promise<BurstItemResult> {
  try {
    return {
      kind: "success",
      success: {
        index: request.index,
        nonce: null,
        id: await submit(request),
        blockNumber: null,
        gasUsed: null
      }
    }
  } catch (error) {
    return failure(request.index, null, formatError(error))
  }
}

function failure(
  index: number,
  nonce: number | null,
  reason: string
): BurstItemResult {
  return { kind: "failure", failure: { index, nonce, reason } }
}

async function runBounded<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item) => Promise<Result>
): Promise<readonly Result[]> {
  const chunks = chunk(items, concurrency)
  return chunks.reduce<Promise<readonly Result[]>>(
    async (prior, nextChunk) => [
      ...(await prior),
      ...(await Promise.all(nextChunk.map(worker)))
    ],
    Promise.resolve([])
  )
}

function chunk<Item>(
  items: readonly Item[],
  size: number
): readonly (readonly Item[])[] {
  return items.length === 0
    ? []
    : [items.slice(0, size), ...chunk(items.slice(size), size)]
}

function collectBurstResults(results: readonly BurstItemResult[]): BurstResult {
  return {
    successes: results
      .filter(
        (result): result is Extract<BurstItemResult, { kind: "success" }> =>
          result.kind === "success"
      )
      .map(result => result.success),
    failures: results
      .filter(
        (result): result is Extract<BurstItemResult, { kind: "failure" }> =>
          result.kind === "failure"
      )
      .map(result => result.failure)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
