import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/** Stress identity fixture sizes used by package-local unit tests. */
export namespace StressIdentityFixtures {
  /** Small count that still proves uniqueness beyond a single identity. */
  export const Count = 3
}

/** Envelope fixture knobs shared by the metrics collector unit tests. */
export namespace EnvelopeMetricFixtures {
  /** Endpoint direction used by the saturation fixtures. */
  export const EndpointsType = DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
  /** Epoch index all same-phase saturation fixtures share. */
  export const EpochIndex = 17
  /** Timestamp used by fixture envelopes and metadata. */
  export const EpochTimestamp = 1_775_612_516_983n
  /** Storage filename checksum width used by debugging server fixtures. */
  export const ChecksumHexChars = 16
  /** Zero-padded epoch width used by OPP debug storage keys. */
  export const EpochIndexPadWidth = 8
}

/** Burst helper fixture values shared by bounded-concurrency unit tests. */
export namespace BurstFixtures {
  /** Small burst count that proves queueing without load-testing RPC. */
  export const Count = 4
  /** First nonce allocated to the mocked Ethereum burst. */
  export const FirstNonce = 40
  /** Max in-flight submissions expected by the mocked bounded queue. */
  export const Concurrency = 2
  /** Index whose mocked Ethereum transaction fails. */
  export const FailingIndex = 2
  /** Nonce whose mocked Ethereum transaction fails. */
  export const FailingNonce = FirstNonce + FailingIndex
  /** Minimal ETH swap request fixtures; exact slug values are irrelevant to mocked surface. */
  export const EthereumRequests = Array.from(
    { length: Count },
    (_value, index) => ({
      index,
      sourceTokenCode: 1n,
      sourceReserveCode: 2n,
      sourceAmountWei: 3n,
      targetChainCode: 4n,
      targetTokenCode: 5n,
      targetReserveCode: 6n,
      targetRecipient: new Uint8Array([index + 1]),
      targetAmount: 7n,
      targetToleranceBps: 8
    })
  )
  /** Minimal SOL/SPL request fixtures for bounded inverse-route submission. */
  export const SolanaRequests = Array.from(
    { length: Count },
    (_value, index) => ({
      index,
      request: EthereumRequests[index]
    })
  )
}

/** Ramp-controller fixture values used by synthetic evidence tests. */
export namespace RampFixtures {
  /** Synthetic endpoint label persisted into JSON evidence. */
  export const Endpoint = "OUTPOST_ETHEREUM_DEPOT"
  /** First account count in the doubling ramp. */
  export const InitialCount = 2
  /** Doubling multiplier used by the stress ramp. */
  export const Multiplier = 2
  /** Max synthetic count for unit tests. */
  export const MaxCount = 16
  /** Synthetic phase timeout metadata. */
  export const PhaseTimeoutMs = 30_000
  /** Account count where synthetic metrics saturate. */
  export const SaturatingCount = 16
  /** Account count where synthetic tx breakage appears. */
  export const BreakageCount = 4
  /** Stable start timestamp for JSON assertions. */
  export const StartedAtMs = 1_775_612_500_000
  /** Stable end timestamp for JSON assertions. */
  export const EndedAtMs = StartedAtMs + 1_000
  /** Synthetic epoch lower bound. */
  export const EpochStart = 20
  /** Synthetic epoch upper bound. */
  export const EpochEnd = 21
  /** Ramp constants used by both controller tests. */
  export const Config = {
    initialCount: InitialCount,
    multiplier: Multiplier,
    maxCount: MaxCount,
    phaseTimeoutMs: PhaseTimeoutMs
  }
}
