import type {
  OppStressRampDeferredEvidenceBreakageObservation,
  OppStressRampDeferredEvidenceCompletedObservation,
  RampBreakageCategory
} from "@wireio/test-opp-stress"
import type {
  EthereumBurstReserveManager,
  SolanaBurstRequest
} from "./boundedBursts.js"
import type { StressIdentities } from "./stressIdentities.js"
import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type {
  SwapStressTelemetryDegradation,
  SwapStressTelemetryDeps
} from "./phaseRunnerTelemetry.js"

/** Source amounts and precision constants for the bidirectional stress phases. */
export namespace SwapStressPhaseAmounts {
  /** Phase 1 ETH source: 0.1 ETH in wei; changes per-tx private-pair draw. */
  export const Phase1SourceWei = 100_000_000_000_000_000n
  /** Phase 1 ETH source in depot 9-decimal units. */
  export const Phase1SourceDepotUnits = Phase1SourceWei / 10n ** 9n
  /** Phase 2 USDCSOL source in SPL base units. */
  export const Phase2SourceSplUnits = 100_000n
  /** Phase 2 WIRE source in depot base units. */
  export const Phase2SourceWireUnits = 100_000_000n
  /** Phase 2 USDCSOL source in depot units; USDCSOL keeps native 6 decimals. */
  export const Phase2SourceDepotUnits = Phase2SourceSplUnits
  /** Depot 9-decimal ETH to native wei scale for return payout observation. */
  export const EthWeiPerDepotUnit = 1_000_000_000n
  /** USDCSOL depot precision equals native SPL precision. */
  export const UsdcSolFromDepotDivisor = 1n
  /** 5% target tolerance mirrors private-reserve flow variance tolerance. */
  export const TargetToleranceBps = 500
}

/** Stress phases executed by the runner. */
export type SwapStressPhase = "phase-1" | "phase-2"

/** Reserve row amounts read live before quote computation. */
export type SwapStressReserveRowSnapshot = {
  /** Chain-side reserve amount in depot frame. */
  readonly chain: bigint
  /** WIRE-side reserve amount. */
  readonly wire: bigint
}

/** ETH public and SOL private reserve rows read as one live quote baseline. */
export type SwapStressReservePairSnapshot = {
  /** ETH/PRIMARY live reserve row. */
  readonly ethereum: SwapStressReserveRowSnapshot
  /** SOLANA-USDCSOL/PRIVATE live reserve row. */
  readonly solana: SwapStressReserveRowSnapshot
}

/** Chain/token/private-reserve route codes for both stress phases. */
export type SwapStressRouteCodes = {
  /** ETHEREUM chain slug_name. */
  readonly ethereumChainCode: bigint
  /** ETH native token slug_name. */
  readonly ethereumTokenCode: bigint
  /** SOLANA chain slug_name. */
  readonly solanaChainCode: bigint
  /** USDCSOL token slug_name. */
  readonly solanaTokenCode: bigint
  /** WIRE chain slug_name. */
  readonly wireChainCode: bigint
  /** WIRE token slug_name. */
  readonly wireTokenCode: bigint
  /** Non-zero WIRE target reserve sentinel slug_name. */
  readonly wireSentinelReserveCode: bigint
  /** Shared PRIVATE reserve slug_name. */
  readonly privateReserveCode: bigint
}

/** Phase 2 WIRE-source swap request payload passed to the real submitter. */
export type Phase2SwapRequest = {
  /** Stable burst index. */
  readonly index: number
  /** WIRE account that escrows the source amount. */
  readonly sourceAccount: string
  /** Phase 2 WIRE source amount in depot base units. */
  readonly sourceAmount: bigint
  /** ETH target chain slug_name. */
  readonly targetChainCode: bigint
  /** ETH target token slug_name. */
  readonly targetTokenCode: bigint
  /** ETH public reserve slug_name. */
  readonly targetReserveCode: bigint
  /** Original ETH recipient address bytes. */
  readonly targetRecipient: Uint8Array
  /** Minimum ETH depot-frame target amount. */
  readonly targetAmount: bigint
  /** Variance tolerance in basis points. */
  readonly targetToleranceBps: number
}

/** Destination identity watched by a payout observer. */
export type SwapStressPayoutTarget = {
  /** Stable burst identity index. */
  readonly index: number
  /** Chain-native destination address or public key. */
  readonly address: string
}

/** Request passed to payout observers for one completed phase. */
export type SwapStressPayoutObservationRequest = {
  /** Phase whose remit payout is being observed. */
  readonly phase: SwapStressPhase
  /** Number of burst recipients that could receive payout. */
  readonly expectedCount: number
  /** Minimum observed payouts required for the phase to proceed. */
  readonly minimumObservedCount: number
  /** Per-recipient target amount in the destination chain's base units. */
  readonly targetAmount: bigint
  /** Destination identities that may receive the phase payout. */
  readonly targets: readonly SwapStressPayoutTarget[]
}

/** Payout observation returned by a chain-specific balance watcher. */
export type SwapStressPayoutObservation = SwapStressPayoutObservationRequest & {
  /** Number of recipients/accounts whose balance crossed the target floor. */
  readonly observedCount: number
}

/** Chain-specific balance watcher for recipient or return payouts. */
export interface SwapStressPayoutObserver {
  /**
   * Optionally capture pre-burst destination balances for delta-based observers.
   *
   * @param request Phase, target amount, and destination identities.
   */
  readonly preparePayouts?: (
    request: SwapStressPayoutObservationRequest
  ) => Promise<void>

  /**
   * Wait until enough phase payouts are visible on the destination chain.
   *
   * @param request Phase, target amount, and minimum observation count.
   * @returns Observed payout count and target metadata.
   */
  waitForPayouts(
    request: SwapStressPayoutObservationRequest
  ): Promise<SwapStressPayoutObservation>
}

/** Request passed to the optional batch-operator failure probe after payout observation fails. */
export type SwapStressBatchOperatorFailureRequest = {
  /** Phase whose payout failed to appear. */
  readonly phase: SwapStressPhase
  /** Inclusive phase start timestamp. */
  readonly startedAtMs: number
  /** Timestamp after the failed payout observation completed. */
  readonly endedAtMs: number
  /** Original payout observer failure text. */
  readonly payoutFailureReason: string
}

/** Clean phase evidence carried by completed and workload-breakage observations. */
export type SwapStressCleanEvidence = {
  readonly phaseResults: readonly SwapStressPhaseResult[]
  readonly telemetryDegradation: null
}

/** Phase evidence carrying an exact terminal telemetry degradation. */
export type SwapStressDegradedEvidence = {
  readonly phaseResults: readonly SwapStressPhaseResult[]
  readonly telemetryDegradation: SwapStressTelemetryDegradation
}

/** Completed phase-runner observation with no controller-owned metadata. */
export type SwapStressCompletedObservation =
  OppStressRampDeferredEvidenceCompletedObservation<SwapStressCleanEvidence>

/** Workload breakage observation with clean telemetry evidence. */
export type SwapStressWorkloadBreakageObservation =
  OppStressRampDeferredEvidenceBreakageObservation<SwapStressCleanEvidence> & {
    readonly breakageCategory: RampBreakageCategory.Workload
  }

/** Telemetry-integrity breakage observation with exact degradation evidence. */
export type SwapStressTelemetryBreakageObservation =
  OppStressRampDeferredEvidenceBreakageObservation<SwapStressDegradedEvidence> & {
    readonly breakageCategory: RampBreakageCategory.TelemetryIntegrity
  }

/** Final observation-only callback contract for one flow iteration. */
export type SwapStressIterationObservation =
  | SwapStressCompletedObservation
  | SwapStressWorkloadBreakageObservation
  | SwapStressTelemetryBreakageObservation

/** Evidence payload accepted by the flow's generic deferred parser. */
export type SwapStressObservationEvidence =
  SwapStressCleanEvidence | SwapStressDegradedEvidence

/** Nontelemetry collaborators required for one bidirectional stress iteration. */
type SwapStressNonTelemetryPhaseRunnerDeps = {
  /** Route constants for private ETH <-> USDCSOL swaps. */
  readonly route: SwapStressRouteCodes
  /** Read live ACTIVE private reserve row snapshots. */
  readonly readReservePairSnapshot: () => Promise<SwapStressReservePairSnapshot>
  /** Generate or supply deterministic stress identities for this count. */
  readonly createIdentities?: (count: number) => StressIdentities
  /** ReserveManager bound to the original ETH account. */
  readonly ethereumReserveManager: EthereumBurstReserveManager
  /** Reserve and return the original ETH account's first nonce before phase 1 burst. */
  readonly getEthereumFirstNonce: (count: number) => Promise<number>
  /** Submit one WIRE-source swap action and return its transaction id. */
  readonly submitPhase2Swap: (
    request: SolanaBurstRequest<Phase2SwapRequest>
  ) => Promise<string>
  /** Wait for at least one generated recipient payout after phase 1. */
  readonly recipientPayoutObserver: SwapStressPayoutObserver
  /** Wait for at least one original-account return payout after phase 2. */
  readonly returnPayoutObserver: SwapStressPayoutObserver
  /** Optional probe for concrete batch-operator delivery failures. */
  readonly batchOperatorFailureProbe?: (
    request: SwapStressBatchOperatorFailureRequest
  ) => Promise<string | null>
  /** Max in-flight transactions for each burst. */
  readonly concurrency: number
  /** Clock used for deterministic tests and phase windows. */
  readonly clock?: () => number
}

/** Collaborators required to run one bidirectional stress iteration. */
export type SwapStressPhaseRunnerDeps = SwapStressNonTelemetryPhaseRunnerDeps &
  SwapStressTelemetryDeps

/** Minimal runner surface consumed by the future ramp/e2e todo. */
export type SwapStressPhaseRunner = {
  /**
   * Run one bidirectional stress iteration.
   *
   * @param count Number of generated recipient/source identity pairs.
   * @returns Completed or typed breakage observation with per-phase evidence.
   */
  readonly runIteration: (
    count: number
  ) => Promise<SwapStressIterationObservation>
}

/** Error raised when live reserve rows cannot produce a positive target. */
export class SwapStressImpossibleQuoteError extends Error {
  /** Phase whose quote failed. */
  readonly phase: SwapStressPhase

  /**
   * Create an impossible quote error.
   *
   * @param phase Phase whose two-hop quote produced zero.
   */
  constructor(phase: SwapStressPhase) {
    super(`${phase} quote produced zero target`)
    this.name = "SwapStressImpossibleQuoteError"
    this.phase = phase
  }
}
