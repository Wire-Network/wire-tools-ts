// Synthetic IndexBalanceDump generator for flow-emissions-soak.
//
// We deliberately do NOT commit live index dumps or pre-computed importseed
// batches to the repo. Instead each run builds its own dump in the same shape
// `https://index.wire.foundation/opp/[solana/]balances` emits, so the
// seed → importseed → unmapped_tokens path is exercised against the same
// conversion logic without ever touching the live API.
//
// The bulk generator is deterministic given a seed — useful for failure
// reproduction. Controlled stakers are RANDOM Ethereum wallets the scenario's
// pre-bootstrap stage generates through the `KeyGenerator` facade and persists
// under durable handles, so a step runner reads a staker's wallet back by its
// handle (no key material rides step inputs or the report).

import { Keypair } from "@solana/web3.js"
import {
  EthereumFundingTool,
  KeyGenerator,
  type EthereumKeyPair,
  type IndexBalanceDump
} from "@wireio/cluster-tool"

/** ETH-style address length in raw bytes. */
const EthereumAddressByteLength = 20
/** The `0x` prefix an EVM address carries in display form, absent from the dump shape. */
const EthereumAddressPrefixPattern = /^0x/
/** Exclusive upper bound of a single random byte. */
const ByteValueRange = 256
/** Bits drawn per PRNG chunk when assembling a random bigint. */
const RandomChunkBits = 32
/** One PRNG chunk's value range (2^32). */
const RandomChunkRange = 0x1_0000_0000
/** Default PRNG seed for the ETH dump (stable across runs). */
const DefaultEthereumSeed = 1
/** Default PRNG seed for the SOL dump. */
const DefaultSolanaSeed = 2
/** Default ETH source-decimal magnitude floor (1 ETH-style unit, 18 decimals). */
const DefaultEthereumMinimumSourceUnits = 1_000_000_000_000_000_000n
/** Default SOL source-decimal magnitude floor (1 SOL-style unit, 9 decimals). */
const DefaultSolanaMinimumSourceUnits = 1_000_000_000n
/** Random amounts fall in roughly `[minimum, (1 + spread) * minimum)`. */
const RandomAmountSpread = 99n
/** Sysio-name-safe letters for controlled-staker account suffixes. */
const AccountSuffixLetters = "abcdefghijklmnopqrstuvwxyz"

/**
 * Mulberry32 — small, fast, deterministic PRNG. Not cryptographically secure;
 * we just need reproducible address + amount generation for fixtures.
 *
 * @param seed - 32-bit PRNG seed.
 * @return A generator of floats in `[0, 1)`.
 */
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

/**
 * A random bigint in `[1, max)` — 32-bit chunks are drawn until they cover the
 * bit-length of `max`, then reduced modulo `max`, floored at `1n` so empty
 * totals are never emitted.
 *
 * @param rng - The seeded PRNG.
 * @param max - Exclusive upper bound.
 * @return The random value.
 */
function randomBigInt(rng: () => number, max: bigint): bigint {
  if (max <= 1n) return 1n
  const bits = max.toString(2).length,
    chunkCount = Math.ceil(bits / RandomChunkBits),
    total =
      Array.from({ length: chunkCount }, () =>
        BigInt(Math.floor(rng() * RandomChunkRange))
      ).reduce(
        (accumulator, chunk, index) =>
          accumulator + (chunk << BigInt(index * RandomChunkBits)),
        0n
      ) % max
  return total === 0n ? 1n : total
}

/**
 * Lowercase hex of `byteLength` random bytes (no `0x` prefix).
 *
 * @param rng - The seeded PRNG.
 * @param byteLength - Number of random bytes to draw.
 * @return The hex string.
 */
function randomBytesHex(rng: () => number, byteLength: number): string {
  return Array.from({ length: byteLength }, () =>
    Math.floor(rng() * ByteValueRange)
  )
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Encode a zero-based index over `a…z` (base-26; digit `0` is invalid in sysio
 * account names, so letters only) — `0 → "a"`, `25 → "z"`, `26 → "aa"`.
 *
 * @param index - Zero-based staker index.
 * @return The letter suffix.
 */
function toLetterSuffix(index: number): string {
  return index < AccountSuffixLetters.length
    ? AccountSuffixLetters[index]
    : `${toLetterSuffix(Math.floor(index / AccountSuffixLetters.length) - 1)}${
        AccountSuffixLetters[index % AccountSuffixLetters.length]
      }`
}

// ---------------------------------------------------------------------------
// Controlled stakers — the flow holds their ETH wallets, so the
// link → claim path can run end-to-end against entries we control.
// ---------------------------------------------------------------------------

/**
 * A controlled ETH staker's JSON-safe identity — everything a step input needs
 * to name it. The wallet itself is read back on demand by its durable handle
 * (`EthereumFundingTool.signer`), so no key material is stored here.
 */
export interface ControlledStakerIdentity {
  /** The WIRE account registered for this staker (`soak.sa`, …). */
  wireAccount: string
  /** Lower-case hex ETH address WITHOUT `0x` prefix (importseed dump shape). */
  addressHex: string
  /** Durable handle of the staker's persisted Ethereum wallet. */
  walletName: string
}

/** Options for {@link createControlledStakerIdentities}. */
export interface ControlledStakerOptions {
  /** The cluster data directory the wallets persist under. */
  dataPath: string
  /** The key-generation tooling (`KeyGenerator.context(buildPath)`). */
  context: KeyGenerator.Context
  /** Number of controlled stakers. */
  count: number
  /** Prefix for the generated WIRE account names. */
  wireAccountPrefix: string
  /** Prefix for the wallet handles (`<prefix>0`, `<prefix>1`, …). */
  walletNamePrefix: string
}

/**
 * Get-or-create one controlled staker's wallet under its handle: a random pair
 * from the `KeyGenerator` facade, persisted once; a handle already holding a
 * wallet is read back verbatim, so a re-run keeps the identity its dump names.
 *
 * @param options - The roster options.
 * @param index - The staker's zero-based index.
 * @return The staker's persisted pair.
 */
async function createControlledStakerWallet(
  options: ControlledStakerOptions,
  index: number
): Promise<EthereumKeyPair> {
  const { dataPath, context, walletNamePrefix } = options
  return EthereumFundingTool.createWallet(
    dataPath,
    `${walletNamePrefix}${index}`,
    context,
    `flow-emissions-soak — controlled staker ${index} wallet`
  )
}

/**
 * Create the controlled-staker identities: one random Ethereum wallet per
 * staker, persisted under its handle (see {@link createControlledStakerWallet}),
 * paired with a sysio-name-safe WIRE account.
 *
 * @param options - The roster options.
 * @return The identities in index order.
 */
export async function createControlledStakerIdentities(
  options: ControlledStakerOptions
): Promise<ControlledStakerIdentity[]> {
  const { count, wireAccountPrefix, walletNamePrefix } = options
  return Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const pair = await createControlledStakerWallet(options, index)
      return {
        wireAccount: `${wireAccountPrefix}${toLetterSuffix(index)}`,
        addressHex: pair.address
          .toLowerCase()
          .replace(EthereumAddressPrefixPattern, ""),
        walletName: `${walletNamePrefix}${index}`
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Synthetic ETH dump
// ---------------------------------------------------------------------------

/** Options for {@link createSyntheticEthereumDump}. */
export interface EthereumDumpOptions {
  /** Deterministic PRNG seed. Default: 1 (stable across runs). */
  seed?: number
  /** Standalone purchaser rows (no overlap with stakers/controlled). */
  purchaserCount?: number
  /** Standalone staker rows (no overlap with purchasers/controlled). */
  stakerCount?: number
  /**
   * Addresses appearing in BOTH purchasers and stakers — exercises the dedup
   * path in `convertImportSeed`. Each side contributes a random amount; the
   * converter sums them on raw-bytes keys.
   */
  overlappingCount?: number
  /**
   * Stakers with a non-zero `yieldClaimed` — exercises the netting path
   * `owed = pretokenYield - yieldClaimed` (always a partial claim, so the row
   * survives conversion).
   */
  yieldClaimedCount?: number
  /** Controlled stakers — appended as purchasers (no `yieldClaimed`). */
  controlled?: ControlledStakerIdentity[]
  /** Source-decimal (18) total for EVERY controlled staker's purchaser row. */
  controlledSourceUnits?: bigint
  /**
   * Source-decimal magnitude floor for random amounts. Each random row falls
   * in roughly `[minSourceUnits, 100 * minSourceUnits)`. Default 1e18 so the
   * divisor-1e9 conversion produces non-trivial atomic WIRE amounts.
   */
  minSourceUnits?: bigint
}

/**
 * Create a synthetic ETH indexer dump (purchasers + stakers + overlap +
 * yield-claimed netting rows), with the controlled stakers appended as
 * purchasers so dedup logic never suppresses them.
 *
 * @param options - Row counts, seed, and the controlled-staker roster.
 * @return The indexer-shaped dump.
 */
export function createSyntheticEthereumDump(
  options: EthereumDumpOptions = {}
): IndexBalanceDump {
  const rng = mulberry32(options.seed ?? DefaultEthereumSeed),
    { minSourceUnits: minimumSourceUnits = DefaultEthereumMinimumSourceUnits } =
      options,
    randomAddress = (): string =>
      `0x${randomBytesHex(rng, EthereumAddressByteLength)}`,
    randomAmount = (): bigint =>
      minimumSourceUnits +
      randomBigInt(rng, minimumSourceUnits * RandomAmountSpread)

  const standalonePurchasers = Array.from(
      { length: options.purchaserCount ?? 0 },
      () => ({
        address: randomAddress(),
        totalPretokens: randomAmount().toString()
      })
    ),
    standaloneStakers = Array.from(
      { length: options.stakerCount ?? 0 },
      () => ({
        address: randomAddress(),
        pretokenYield: randomAmount().toString()
      })
    ),
    overlappingRows = Array.from(
      { length: options.overlappingCount ?? 0 },
      () => {
        const address = randomAddress()
        return {
          purchaser: { address, totalPretokens: randomAmount().toString() },
          staker: { address, pretokenYield: randomAmount().toString() }
        }
      }
    ),
    yieldClaimedStakers = Array.from(
      { length: options.yieldClaimedCount ?? 0 },
      () => {
        const pretokenYield = randomAmount()
        return {
          address: randomAddress(),
          pretokenYield: pretokenYield.toString(),
          yieldClaimed: randomBigInt(rng, pretokenYield / 2n).toString()
        }
      }
    ),
    controlledPurchasers = (options.controlled ?? []).map(identity => ({
      address: `0x${identity.addressHex}`,
      totalPretokens: (options.controlledSourceUnits ?? 0n).toString()
    })),
    purchasers = [
      ...standalonePurchasers,
      ...overlappingRows.map(row => row.purchaser),
      ...controlledPurchasers
    ],
    stakers = [
      ...standaloneStakers,
      ...overlappingRows.map(row => row.staker),
      ...yieldClaimedStakers
    ]

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalMessages: purchasers.length + stakers.length,
      yieldDust: "0"
    },
    purchasers,
    stakers
  }
}

// ---------------------------------------------------------------------------
// Synthetic SOL dump — bulk-only (no controlled stakers because the
// link/claim path for SVM is owned by a different track).
// ---------------------------------------------------------------------------

/** Options for {@link createSyntheticSolanaDump}. */
export interface SolanaDumpOptions {
  /** Deterministic PRNG seed for the amounts. Default: 2. */
  seed?: number
  /** Standalone purchaser rows. */
  purchaserCount?: number
  /** Standalone staker rows. */
  stakerCount?: number
  /** Source decimals on Solana are 9 (lamport-style). Default 1e9. */
  minSourceUnits?: bigint
}

/**
 * Create a synthetic SOL indexer dump. Addresses are throwaway base58 pubkeys
 * (the keypairs are not retained — bulk-seed only).
 *
 * @param options - Row counts and seed.
 * @return The indexer-shaped dump.
 */
export function createSyntheticSolanaDump(
  options: SolanaDumpOptions = {}
): IndexBalanceDump {
  const rng = mulberry32(options.seed ?? DefaultSolanaSeed),
    { minSourceUnits: minimumSourceUnits = DefaultSolanaMinimumSourceUnits } =
      options,
    randomAddress = (): string => Keypair.generate().publicKey.toBase58(),
    randomAmount = (): bigint =>
      minimumSourceUnits +
      randomBigInt(rng, minimumSourceUnits * RandomAmountSpread)

  const purchasers = Array.from(
      { length: options.purchaserCount ?? 0 },
      () => ({
        address: randomAddress(),
        totalPretokens: randomAmount().toString()
      })
    ),
    stakers = Array.from({ length: options.stakerCount ?? 0 }, () => ({
      address: randomAddress(),
      pretokenYield: randomAmount().toString()
    }))

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalMessages: purchasers.length + stakers.length
    },
    purchasers,
    stakers
  }
}
