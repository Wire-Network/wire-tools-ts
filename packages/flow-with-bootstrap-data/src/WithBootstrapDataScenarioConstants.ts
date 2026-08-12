import Path from "node:path"

import { ChainKind } from "@wireio/opp-typescript-models"
import type { ImportSeedChainKind } from "@wireio/cluster-tool"

/** One exact credit the fixture-driven flow expects after conversion and merge. */
export interface ExpectedBootstrapCredit {
  readonly chain: ImportSeedChainKind
  readonly nativeAddress: string
  readonly wireAtomic: bigint
}

/** Expected conversion summary for one committed fixture. */
export interface ExpectedBootstrapChain {
  readonly chain: ImportSeedChainKind
  readonly eligibleAddressCount: number
  readonly totalAtomic: bigint
  readonly droppedDust: bigint
}

/** Immutable inputs and expectations for the fixture-driven bootstrap flow. */
export namespace WithBootstrapDataScenarioConstants {
  const FixturesPath = Path.resolve(__dirname, "../fixtures")

  /** Committed Ethereum indexer-shaped balance dump. */
  export const EthereumBootstrapJsonFile = Path.join(
    FixturesPath,
    "ethereum-index-balances.json"
  )
  /** Committed Solana indexer-shaped balance dump. */
  export const SolanaBootstrapJsonFile = Path.join(
    FixturesPath,
    "solana-index-balances.json"
  )

  /** Every post-dedup credit expected in the finalized bootstrap plan. */
  export const ExpectedCredits = [
    {
      chain: ChainKind.EVM,
      nativeAddress: "1111111111111111111111111111111111111111",
      wireAtomic: 1_000_000_000n
    },
    {
      chain: ChainKind.EVM,
      nativeAddress: "2222222222222222222222222222222222222222",
      wireAtomic: 2_000_000_000n
    },
    {
      chain: ChainKind.EVM,
      nativeAddress: "3333333333333333333333333333333333333333",
      wireAtomic: 6_000_000_000n
    },
    {
      chain: ChainKind.EVM,
      nativeAddress: "4444444444444444444444444444444444444444",
      wireAtomic: 4_000_000_000n
    },
    {
      chain: ChainKind.SVM,
      nativeAddress:
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
      wireAtomic: 1_000_000_000n
    },
    {
      chain: ChainKind.SVM,
      nativeAddress:
        "02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021",
      wireAtomic: 5_000_000_000n
    },
    {
      chain: ChainKind.SVM,
      nativeAddress:
        "030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122",
      wireAtomic: 4_000_000_000n
    }
  ] as const satisfies readonly ExpectedBootstrapCredit[]

  /** Exact per-chain conversion totals, including Ethereum decimal dust. */
  export const ExpectedChains = [
    {
      chain: ChainKind.EVM,
      eligibleAddressCount: 4,
      totalAtomic: 13_000_000_000n,
      droppedDust: 1_246_913_577n
    },
    {
      chain: ChainKind.SVM,
      eligibleAddressCount: 3,
      totalAtomic: 10_000_000_000n,
      droppedDust: 0n
    }
  ] as const satisfies readonly ExpectedBootstrapChain[]

  /** The fixture set is intentionally small enough to fit one action per chain. */
  export const ExpectedBatchCountPerChain = 1
  /** Query ceiling comfortably above the exact seven-row fixture result. */
  export const UnmappedQueryLimit = 100
}
