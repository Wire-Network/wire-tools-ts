import type { ethers } from "ethers"

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
