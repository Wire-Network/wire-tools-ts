import type { StressIdentities } from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"

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

/**
 * The two-wallet stress identity roster both burst suites drive.
 *
 * @returns Deterministic ETH + SOL identities (hd indexes 128/129).
 */
export function stressIdentities(): StressIdentities {
  return {
    ethereum: [
      {
        index: 0,
        hdIndex: 128,
        address: "0x0000000000000000000000000000000000000001",
        addressBytes: new Uint8Array([1])
      },
      {
        index: 1,
        hdIndex: 129,
        address: "0x0000000000000000000000000000000000000002",
        addressBytes: new Uint8Array([2])
      }
    ],
    solana: [
      {
        index: 0,
        publicKey: "sol-0",
        publicKeyBytes: new Uint8Array([10]),
        secretKey: new Uint8Array([20])
      },
      {
        index: 1,
        publicKey: "sol-1",
        publicKeyBytes: new Uint8Array([11]),
        secretKey: new Uint8Array([21])
      }
    ],
    wire: [
      { index: 0, account: "stressw0", accountBytes: new Uint8Array([30]) },
      { index: 1, account: "stressw1", accountBytes: new Uint8Array([31]) }
    ]
  }
}
