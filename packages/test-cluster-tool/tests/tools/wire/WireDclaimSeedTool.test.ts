// WireDclaimSeedTool.test.ts — harness home of the unit-level importseed
// coverage that previously lived at the bottom of the old flow-emissions-soak
// jest suite (EmissionsSoak.test.ts). Flows carry no jest suites anymore, so
// the `convertImportSeed` + synthetic-dump sanity assertions land here.
//
// The synthetic-dump fixture below is a minimal, deterministic mirror of the
// flow-side generator (flow-emissions-soak's EmissionsSoakScenarioSyntheticDump)
// — harness tests never import from flow-* packages, so the fixture is
// self-contained.

import {
  convertImportSeed,
  serializeBatchForClio,
  type ImportSeedBatch,
  type IndexBalanceDump
} from "@wireio/test-cluster-tool/tools/wire"

// ── Synthetic-dump fixture ─────────────────────────────────────────────────

/** ETH-style address length in raw bytes. */
const EthereumAddressByteLength = 20
/** Exclusive upper bound of a single random byte. */
const ByteValueRange = 256
/** Bits drawn per PRNG chunk when assembling a random bigint. */
const RandomChunkBits = 32
/** One PRNG chunk's value range (2^32). */
const RandomChunkRange = 0x1_0000_0000
/** ETH source-decimal magnitude floor (1 ETH-style unit, 18 decimals). */
const EthereumMinimumSourceUnits = 1_000_000_000_000_000_000n
/** Random amounts fall in roughly `[minimum, (1 + spread) * minimum)`. */
const RandomAmountSpread = 99n

/** Mulberry32 — small, deterministic PRNG for reproducible fixture rows. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / RandomChunkRange
  }
}

/** A random bigint in `[1, max)` drawn from the seeded PRNG. */
function randomBigInt(rng: () => number, max: bigint): bigint {
  if (max <= 1n) return 1n
  const bits = max.toString(2).length
  const chunkCount = Math.ceil(bits / RandomChunkBits)
  const total =
    Array.from({ length: chunkCount }, () =>
      BigInt(Math.floor(rng() * RandomChunkRange))
    ).reduce(
      (accumulator, chunk, index) =>
        accumulator + (chunk << BigInt(index * RandomChunkBits)),
      0n
    ) % max
  return total === 0n ? 1n : total
}

/** Lowercase hex of `byteLength` random bytes (no `0x` prefix). */
function randomBytesHex(rng: () => number, byteLength: number): string {
  return Array.from({ length: byteLength }, () =>
    Math.floor(rng() * ByteValueRange)
  )
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Options for {@link buildSyntheticEthereumDump} — the subset of the
 * flow-side generator's `EthereumDumpOptions` these tests exercise.
 */
interface EthereumDumpOptions {
  /** Deterministic PRNG seed. */
  seed: number
  /** Standalone purchaser rows (no overlap with stakers/controlled). */
  purchaserCount: number
  /** Standalone staker rows (no overlap with purchasers/controlled). */
  stakerCount: number
  /**
   * Addresses appearing in BOTH purchasers and stakers — exercises the
   * dedup path in `convertImportSeed`.
   */
  overlappingCount: number
  /**
   * Stakers with a non-zero `yieldClaimed` — exercises the netting path
   * `owed = pretokenYield - yieldClaimed` (always a partial claim, so the
   * row survives conversion).
   */
  yieldClaimedCount?: number
  /** Controlled addresses — appended as purchasers (no `yieldClaimed`). */
  controlled?: { addressHex: string }[]
  /** Source-decimal (18) total for EVERY controlled purchaser row. */
  controlledSourceUnits?: bigint
}

/**
 * Build a synthetic ETH indexer dump (purchasers + stakers + overlap +
 * yield-claimed netting rows), with controlled addresses appended as
 * fixed-amount purchasers so dedup logic never suppresses them.
 */
function buildSyntheticEthereumDump(
  options: EthereumDumpOptions
): IndexBalanceDump {
  const rng = mulberry32(options.seed)
  const randomAddress = (): string =>
    `0x${randomBytesHex(rng, EthereumAddressByteLength)}`
  const randomAmount = (): bigint =>
    EthereumMinimumSourceUnits +
    randomBigInt(rng, EthereumMinimumSourceUnits * RandomAmountSpread)

  const standalonePurchasers = Array.from(
    { length: options.purchaserCount },
    () => ({
      address: randomAddress(),
      totalPretokens: randomAmount().toString()
    })
  )
  const standaloneStakers = Array.from({ length: options.stakerCount }, () => ({
    address: randomAddress(),
    pretokenYield: randomAmount().toString()
  }))
  const overlappingRows = Array.from(
    { length: options.overlappingCount },
    () => {
      const address = randomAddress()
      return {
        purchaser: { address, totalPretokens: randomAmount().toString() },
        staker: { address, pretokenYield: randomAmount().toString() }
      }
    }
  )
  const yieldClaimedStakers = Array.from(
    { length: options.yieldClaimedCount ?? 0 },
    () => {
      const pretokenYield = randomAmount()
      return {
        address: randomAddress(),
        pretokenYield: pretokenYield.toString(),
        yieldClaimed: randomBigInt(rng, pretokenYield / 2n).toString()
      }
    }
  )
  const controlledPurchasers = (options.controlled ?? []).map(identity => ({
    address: `0x${identity.addressHex}`,
    totalPretokens: (options.controlledSourceUnits ?? 0n).toString()
  }))

  return {
    purchasers: [
      ...standalonePurchasers,
      ...overlappingRows.map(row => row.purchaser),
      ...controlledPurchasers
    ],
    stakers: [
      ...standaloneStakers,
      ...overlappingRows.map(row => row.staker),
      ...yieldClaimedStakers
    ]
  }
}

describe("WireDclaimSeedTool", () => {
  describe("convertImportSeed", () => {
    it("batches an empty dump into zero batches", () => {
      const result = convertImportSeed(
        { purchasers: [], stakers: [] },
        { chain: "CHAIN_KIND_EVM" }
      )
      expect(result.batches).toHaveLength(0)
      expect(result.totalAtomic).toBe(0n)
      expect(result.uniqueAddresses).toBe(0)
      expect(result.nonZeroCredits).toBe(0)
      expect(result.droppedDust).toBe(0n)
    })

    it("dedupes addresses appearing in both purchasers and stakers", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          { address: `0x${"11".repeat(20)}`, totalPretokens: "5000000000" }
        ],
        stakers: [
          {
            address: `0x${"11".repeat(20)}`,
            pretokenYield: "3000000000",
            yieldClaimed: "1000000000"
          }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      expect(result.uniqueAddresses).toBe(1)
      expect(result.nonZeroCredits).toBe(1)
      const credit = result.batches[0].credits[0]
      // (5000000000 + (3000000000 - 1000000000)) / 1e9 = 7 atomic WIRE.
      expect(credit.wire_atomic).toBe(7n)
      expect(credit.native_address).toBe("11".repeat(20))
    })

    it("drops sub-atomic dust on ETH and reports it", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          { address: `0x${"22".repeat(20)}`, totalPretokens: "1500000000" }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      expect(result.batches[0].credits[0].wire_atomic).toBe(1n)
      expect(result.droppedDust).toBe(500_000_000n)
    })

    it("emits SOL credits 1:1 (divisor = 1, no dust)", () => {
      const dump: IndexBalanceDump = {
        purchasers: [
          {
            address: "4vJ9JU1bJJE96FbKdjWme2JC2nKjpGoxiNzU1S6mYP78",
            totalPretokens: "987654321"
          }
        ]
      }
      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_SVM" })
      expect(result.batches[0].credits[0].wire_atomic).toBe(987_654_321n)
      expect(result.droppedDust).toBe(0n)
    })

    it("chunks per batchSize and serializes BigInts as strings for clio", () => {
      const dump: IndexBalanceDump = {
        purchasers: Array.from({ length: 5 }, (_unused, index) => ({
          address: `0x${(index + 1).toString(16).padStart(2, "0").repeat(20)}`,
          totalPretokens: "1000000000"
        }))
      }
      const result = convertImportSeed(dump, {
        chain: "CHAIN_KIND_EVM",
        batchSize: 2
      })
      expect(result.batches.map(batch => batch.credits.length)).toEqual([
        2, 2, 1
      ])
      expect(
        result.batches.every(batch => batch.chain === "CHAIN_KIND_EVM")
      ).toBe(true)
      const serialized = serializeBatchForClio(result.batches[0])
      expect(typeof serialized.credits[0].wire_atomic).toBe("string")
      expect(serialized.credits[0].wire_atomic).toBe("1")
    })

    it("skips a staker whose yieldClaimed consumes the entire pretokenYield", () => {
      const result = convertImportSeed(
        {
          stakers: [
            {
              address: `0x${"44".repeat(20)}`,
              pretokenYield: "5000000000",
              yieldClaimed: "5000000000"
            }
          ]
        },
        { chain: "CHAIN_KIND_EVM" }
      )
      expect(result.uniqueAddresses).toBe(0)
      expect(result.nonZeroCredits).toBe(0)
      expect(result.batches).toHaveLength(0)
      expect(result.totalAtomic).toBe(0n)
      expect(result.droppedDust).toBe(0n)
    })

    it("throws on an invalid ethereum address", () => {
      expect(() =>
        convertImportSeed(
          { purchasers: [{ address: "0x1234", totalPretokens: "1000000000" }] },
          { chain: "CHAIN_KIND_EVM" }
        )
      ).toThrow(/invalid ethereum address/)
    })

    it("throws when batchSize is not positive", () => {
      expect(() =>
        convertImportSeed(
          {
            purchasers: [
              { address: `0x${"33".repeat(20)}`, totalPretokens: "1000000000" }
            ]
          },
          { chain: "CHAIN_KIND_EVM", batchSize: 0 }
        )
      ).toThrow(/batch size must be > 0/)
    })
  })

  describe("serializeBatchForClio", () => {
    it("serializes chain, native_address, and wire_atomic as a clio-ready payload", () => {
      const batch: ImportSeedBatch = {
        chain: "CHAIN_KIND_EVM",
        credits: [
          { native_address: "aa".repeat(20), wire_atomic: 7n },
          { native_address: "bb".repeat(20), wire_atomic: 1_000_000_000n }
        ]
      }
      expect(serializeBatchForClio(batch)).toEqual({
        chain: "CHAIN_KIND_EVM",
        credits: [
          { native_address: "aa".repeat(20), wire_atomic: "7" },
          { native_address: "bb".repeat(20), wire_atomic: "1000000000" }
        ]
      })
    })

    it("serializes wire_atomic beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
      const serialized = serializeBatchForClio({
        chain: "CHAIN_KIND_SVM",
        credits: [
          {
            native_address: "cc".repeat(32),
            wire_atomic: 9_007_199_254_740_993n
          }
        ]
      })
      expect(serialized.credits[0].wire_atomic).toBe("9007199254740993")
      // The whole point of the string form: the payload is JSON-safe.
      expect(() => JSON.stringify(serialized)).not.toThrow()
    })

    it("serializes an empty batch to an empty credits array", () => {
      expect(
        serializeBatchForClio({ chain: "CHAIN_KIND_EVM", credits: [] })
      ).toEqual({ chain: "CHAIN_KIND_EVM", credits: [] })
    })
  })

  describe("synthetic dump fixture (unit-level sanity)", () => {
    it("is deterministic given the same seed", () => {
      const first = buildSyntheticEthereumDump({
        seed: 42,
        purchaserCount: 3,
        stakerCount: 3,
        overlappingCount: 1
      })
      const second = buildSyntheticEthereumDump({
        seed: 42,
        purchaserCount: 3,
        stakerCount: 3,
        overlappingCount: 1
      })
      expect(first).toEqual(second)
    })

    it("produces dumps that convertImportSeed accepts and counts correctly", () => {
      const controlled = [
        { addressHex: "aa".repeat(20) },
        { addressHex: "bb".repeat(20) }
      ]
      const dump = buildSyntheticEthereumDump({
        seed: 7,
        purchaserCount: 4,
        stakerCount: 3,
        overlappingCount: 2, // adds 2 rows to each side
        yieldClaimedCount: 1, // adds 1 row to stakers
        controlled, // adds 2 rows to purchasers
        controlledSourceUnits: 10n ** 18n
      })
      // Row counts in the raw dump:
      //   purchasers = 4 (standalone) + 2 (overlap) + 2 (controlled) = 8
      //   stakers    = 3 (standalone) + 2 (overlap) + 1 (yieldClaimed) = 6
      expect(dump.purchasers).toHaveLength(8)
      expect(dump.stakers).toHaveLength(6)

      const result = convertImportSeed(dump, { chain: "CHAIN_KIND_EVM" })
      // Unique addresses = 8 + 6 − 2 (dedup of overlapping) = 12
      expect(result.uniqueAddresses).toBe(12)
      // All amounts are ≥ 1e18 source units → ≥ 1 atomic WIRE → no
      // floor-to-zero filtering.
      expect(result.nonZeroCredits).toBe(12)
    })
  })
})
