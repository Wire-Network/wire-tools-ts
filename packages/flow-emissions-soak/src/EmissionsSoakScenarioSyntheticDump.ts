// Synthetic IndexBalanceDump generator for flow-emissions-soak.
//
// We deliberately do NOT commit live index dumps or pre-computed importseed
// batches to the repo. Instead each run builds its own dump in the same shape
// `https://index.wire.foundation/opp/[solana/]balances` emits, so the
// seed → importseed → unmapped_tokens path is exercised against the same
// conversion logic without ever touching the live API.
//
// The bulk generator is deterministic given a seed — useful for failure
// reproduction. Controlled stakers derive from the shared Anvil mnemonic at
// fixed HD indexes, so a step runner can re-derive a staker's wallet from its
// index alone (no private-key material rides step inputs or the report).

import { Keypair } from "@solana/web3.js"
import { ethers } from "ethers"
import {
  EthereumOutpostBootstrapper,
  type IndexBalanceDump
} from "@wireio/test-cluster-tool"

/** ETH-style address length in raw bytes. */
const EthereumAddressByteLength = 20
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
      Array.from({ length: chunkCount }, () => BigInt(Math.floor(rng() * RandomChunkRange))).reduce(
        (accumulator, chunk, index) => accumulator + (chunk << BigInt(index * RandomChunkBits)),
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
  return Array.from({ length: byteLength }, () => Math.floor(rng() * ByteValueRange))
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
 * to name it. The wallet itself is re-derived on demand from the Anvil
 * mnemonic via {@link controlledStakerWallet}, so no key material is stored.
 */
export interface ControlledStakerIdentity {
  /** The WIRE account registered for this staker (`soak.sa`, …). */
  wireAccount: string
  /** Lower-case hex ETH address WITHOUT `0x` prefix (importseed dump shape). */
  addressHex: string
  /** Anvil-mnemonic HD index the staker's ETH wallet derives from. */
  ethereumHdIndex: number
}

/**
 * Derive the ETH wallet at an Anvil-mnemonic HD index — the single source
 * pairing an HD index with its signing wallet (authex-link signing needs no
 * provider connection).
 *
 * @param ethereumHdIndex - The HD index under the shared derivation path.
 * @return The derived HD wallet.
 */
function walletAtHdIndex(ethereumHdIndex: number): ethers.HDNodeWallet {
  return ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(EthereumOutpostBootstrapper.AnvilMnemonic),
    `${EthereumOutpostBootstrapper.DerivationPath}${ethereumHdIndex}`
  )
}

/**
 * Re-derive a controlled staker's ETH wallet from its identity.
 *
 * @param identity - The staker identity.
 * @return The derived HD wallet.
 */
export function controlledStakerWallet(identity: ControlledStakerIdentity): ethers.HDNodeWallet {
  return walletAtHdIndex(identity.ethereumHdIndex)
}

/**
 * Build the controlled-staker identities: deterministic mnemonic-derived ETH
 * wallets at consecutive HD indexes, paired with sysio-name-safe WIRE accounts.
 *
 * @param count - Number of controlled stakers.
 * @param wireAccountPrefix - Prefix for the generated WIRE account names.
 * @param ethereumHdIndexBase - First HD index (consecutive from here).
 * @return The identities in index order.
 */
export function buildControlledStakerIdentities(
  count: number,
  wireAccountPrefix: string,
  ethereumHdIndexBase: number
): ControlledStakerIdentity[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ethereumHdIndex = ethereumHdIndexBase + index
    return {
      wireAccount: `${wireAccountPrefix}${toLetterSuffix(index)}`,
      addressHex: walletAtHdIndex(ethereumHdIndex).address.toLowerCase().replace(/^0x/, ""),
      ethereumHdIndex
    }
  })
}

// ---------------------------------------------------------------------------
// Synthetic ETH dump
// ---------------------------------------------------------------------------

/** Options for {@link buildSyntheticEthereumDump}. */
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
 * Build a synthetic ETH indexer dump (purchasers + stakers + overlap +
 * yield-claimed netting rows), with the controlled stakers appended as
 * purchasers so dedup logic never suppresses them.
 *
 * @param options - Row counts, seed, and the controlled-staker roster.
 * @return The indexer-shaped dump.
 */
export function buildSyntheticEthereumDump(options: EthereumDumpOptions = {}): IndexBalanceDump {
  const rng = mulberry32(options.seed ?? DefaultEthereumSeed),
    minimumSourceUnits = options.minSourceUnits ?? DefaultEthereumMinimumSourceUnits,
    randomAddress = (): string => `0x${randomBytesHex(rng, EthereumAddressByteLength)}`,
    randomAmount = (): bigint =>
      minimumSourceUnits + randomBigInt(rng, minimumSourceUnits * RandomAmountSpread)

  const standalonePurchasers = Array.from({ length: options.purchaserCount ?? 0 }, () => ({
      address: randomAddress(),
      totalPretokens: randomAmount().toString()
    })),
    standaloneStakers = Array.from({ length: options.stakerCount ?? 0 }, () => ({
      address: randomAddress(),
      pretokenYield: randomAmount().toString()
    })),
    overlappingRows = Array.from({ length: options.overlappingCount ?? 0 }, () => {
      const address = randomAddress()
      return {
        purchaser: { address, totalPretokens: randomAmount().toString() },
        staker: { address, pretokenYield: randomAmount().toString() }
      }
    }),
    yieldClaimedStakers = Array.from({ length: options.yieldClaimedCount ?? 0 }, () => {
      const pretokenYield = randomAmount()
      return {
        address: randomAddress(),
        pretokenYield: pretokenYield.toString(),
        yieldClaimed: randomBigInt(rng, pretokenYield / 2n).toString()
      }
    }),
    controlledPurchasers = (options.controlled ?? []).map(identity => ({
      address: `0x${identity.addressHex}`,
      totalPretokens: (options.controlledSourceUnits ?? 0n).toString()
    })),
    purchasers = [
      ...standalonePurchasers,
      ...overlappingRows.map(row => row.purchaser),
      ...controlledPurchasers
    ],
    stakers = [...standaloneStakers, ...overlappingRows.map(row => row.staker), ...yieldClaimedStakers]

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

/** Options for {@link buildSyntheticSolanaDump}. */
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
 * Build a synthetic SOL indexer dump. Addresses are throwaway base58 pubkeys
 * (the keypairs are not retained — bulk-seed only).
 *
 * @param options - Row counts and seed.
 * @return The indexer-shaped dump.
 */
export function buildSyntheticSolanaDump(options: SolanaDumpOptions = {}): IndexBalanceDump {
  const rng = mulberry32(options.seed ?? DefaultSolanaSeed),
    minimumSourceUnits = options.minSourceUnits ?? DefaultSolanaMinimumSourceUnits,
    randomAddress = (): string => Keypair.generate().publicKey.toBase58(),
    randomAmount = (): bigint =>
      minimumSourceUnits + randomBigInt(rng, minimumSourceUnits * RandomAmountSpread)

  const purchasers = Array.from({ length: options.purchaserCount ?? 0 }, () => ({
      address: randomAddress(),
      totalPretokens: randomAmount().toString()
    })),
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
