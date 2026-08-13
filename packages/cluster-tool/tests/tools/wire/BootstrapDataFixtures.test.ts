import Path from "node:path"

import { ChainKind } from "@wireio/opp-typescript-models"
import {
  convertImportSeedCredits,
  loadIndexBalanceDump,
  type ImportSeedChainKind
} from "@wireio/cluster-tool/tools/wire/WireDclaimSeedTool"

interface ExpectedCredit {
  readonly native_address: string
  readonly wire_atomic: bigint
}

/** One committed fixture and its expected exact conversion summary. */
interface FixtureCase {
  readonly chain: ImportSeedChainKind
  readonly file: string
  readonly eligibleAddressCount: number
  readonly totalAtomic: bigint
  readonly droppedDust: bigint
  readonly credits: readonly ExpectedCredit[]
}

const FixturesPath = Path.resolve(
  __dirname,
  "../../../../flow-with-bootstrap-data/fixtures"
)

const FixtureCases = [
  {
    chain: ChainKind.EVM,
    file: Path.join(FixturesPath, "ethereum-index-balances.json"),
    eligibleAddressCount: 4,
    totalAtomic: 13_000_000_000n,
    droppedDust: 1_246_913_577n,
    credits: [
      { native_address: "11".repeat(20), wire_atomic: 1_000_000_000n },
      { native_address: "22".repeat(20), wire_atomic: 2_000_000_000n },
      { native_address: "33".repeat(20), wire_atomic: 6_000_000_000n },
      { native_address: "44".repeat(20), wire_atomic: 4_000_000_000n }
    ]
  },
  {
    chain: ChainKind.SVM,
    file: Path.join(FixturesPath, "solana-index-balances.json"),
    eligibleAddressCount: 3,
    totalAtomic: 10_000_000_000n,
    droppedDust: 0n,
    credits: [
      {
        native_address:
          "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
        wire_atomic: 1_000_000_000n
      },
      {
        native_address:
          "02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021",
        wire_atomic: 5_000_000_000n
      },
      {
        native_address:
          "030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122",
        wire_atomic: 4_000_000_000n
      }
    ]
  }
] as const satisfies readonly FixtureCase[]

describe("bootstrap-data fixtures", () => {
  test.each(FixtureCases)(
    "loads and converts the committed $chain fixture exactly",
    async fixture => {
      const conversion = convertImportSeedCredits(
        await loadIndexBalanceDump(fixture.file, fixture.chain),
        fixture.chain
      )
      expect(conversion).toMatchObject({
        credits: fixture.credits,
        uniqueAddresses: fixture.eligibleAddressCount,
        nonZeroCredits: fixture.eligibleAddressCount,
        totalAtomic: fixture.totalAtomic,
        droppedDust: fixture.droppedDust
      })
    }
  )
})
