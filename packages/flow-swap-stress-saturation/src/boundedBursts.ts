import { runChunkedBoundedWorkload } from "./chunkedBoundedWorkload.js"
import { EthereumBurstDefaults } from "./ethereumBurstDefaults.js"
import type {
  BurstFailure,
  BurstResult,
  BurstSuccess,
  EthereumBurstOptions,
  EthereumBurstReserveManager,
  EthereumBurstSwapRequest,
  SolanaBurstOptions,
  SolanaBurstRequest
} from "./boundedBurstTypes.js"

export type {
  BurstFailure,
  BurstResult,
  BurstSuccess,
  EthereumBurstOptions,
  EthereumBurstReceipt,
  EthereumBurstReserveManager,
  EthereumBurstSwapRequest,
  EthereumBurstTransaction,
  SolanaBurstOptions,
  SolanaBurstRequest
} from "./boundedBurstTypes.js"

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
  const nonces = allocateContiguousNonces(
      options.firstNonce,
      options.requests.length
    ),
    result = await runChunkedBoundedWorkload({
      requests: options.requests,
      concurrency: options.concurrency,
      submit: (request, index) =>
        submitEthereumRequest(
          options.reserveManager,
          request,
          ethereumNonce(index, nonces)
        )
    })
  return {
    successes: result.successes.map(success => success.id),
    failures: result.failures.map(failure =>
      ethereumFailure(
        failure.index,
        failure.reason,
        options.requests,
        nonces
      )
    )
  }
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
  const result = await runChunkedBoundedWorkload({
    requests: options.requests,
    concurrency: options.concurrency,
    submit: request => submitSolanaRequest(options.submit, request)
  })
  return {
    successes: result.successes.map(success => success.id),
    failures: result.failures.map(failure =>
      solanaFailure(failure.index, failure.reason, options.requests)
    )
  }
}

async function submitEthereumRequest(
  reserveManager: EthereumBurstReserveManager,
  request: EthereumBurstSwapRequest,
  nonce: number
): Promise<BurstSuccess> {
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
    throw new RangeError(`receipt status ${receipt?.status ?? "null"}`)
  }
  return {
    index: request.index,
    nonce,
    id: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}

async function submitSolanaRequest<Request>(
  submit: (request: SolanaBurstRequest<Request>) => Promise<string>,
  request: SolanaBurstRequest<Request>
): Promise<BurstSuccess> {
  return {
    index: request.index,
    nonce: null,
    id: await submit(request),
    blockNumber: null,
    gasUsed: null
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`)
  }
}

function ethereumFailure(
  workloadIndex: number,
  reason: string,
  requests: readonly EthereumBurstSwapRequest[],
  nonces: readonly number[]
): BurstFailure {
  const request = requests[workloadIndex],
    index = request?.index ?? workloadIndex,
    nonce = request === undefined ? null : ethereumNonce(workloadIndex, nonces)
  return { index, nonce, reason }
}

function ethereumNonce(workloadIndex: number, nonces: readonly number[]): number {
  const nonce = nonces[workloadIndex]
  if (nonce === undefined) {
    throw new RangeError(`missing nonce for workload index ${workloadIndex}`)
  }
  return nonce
}

function solanaFailure<Request>(
  workloadIndex: number,
  reason: string,
  requests: readonly SolanaBurstRequest<Request>[]
): BurstFailure {
  return {
    index: requests[workloadIndex]?.index ?? workloadIndex,
    nonce: null,
    reason
  }
}
