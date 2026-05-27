// Synthetic IndexBalanceDump generator for flow-emissions-soak.
//
// We deliberately do NOT commit live index dumps or pre-computed
// importseed batches to the repo. Instead each test run builds its own
// dump in the same shape `https://index.wire.foundation/opp/[solana/]balances`
// emits, so the seed → importseed → unmapped_tokens path is exercised
// against the same conversion logic without ever touching the live API.
//
// The generator is deterministic given a seed — useful for failure
// reproduction. Default seed is 1 so concurrent test runs are stable.

import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { type IndexBalanceDump } from "@wireio/test-cluster-tool"

// ---------------------------------------------------------------------------
// Mulberry32 — small, fast, deterministic PRNG. Not cryptographically secure;
// we just need reproducible address + amount generation for fixtures.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function randomBigInt(rng: () => number, max: bigint): bigint {
  // Build a random value in [0, max) by drawing 32-bit chunks until the
  // accumulator covers the bit-length of `max`, then reduce modulo `max`.
  // Floor at 1n so we never emit empty totals.
  if (max <= 1n) return 1n
  const bits = max.toString(2).length
  let total = 0n
  let shift = 0n
  while (shift < BigInt(bits)) {
    const chunk = BigInt(Math.floor(rng() * 0x1_0000_0000))
    total += chunk << shift
    shift += 32n
  }
  total %= max
  return total === 0n ? 1n : total
}

// ---------------------------------------------------------------------------
// Synthetic controlled staker — test holds the private keys, so the
// link → claim path can run end-to-end against entries we control.
// ---------------------------------------------------------------------------
export interface ControlledEthStaker {
  wallet: ethers.HDNodeWallet
  /** Lower-case hex address WITHOUT `0x` prefix (importseed dump shape). */
  addressHex: string
  /** ETH-side total in source decimals (18) — what an indexer would report. */
  totalSourceUnits: bigint
  /** Suggested Wire account name to register for this staker. */
  wireAccount: string
}

export function buildControlledEthStakers(
  count: number,
  wireAccountPrefix: string,
  perStakerSourceUnits: bigint
): ControlledEthStaker[] {
  // Sysio account names allow only `.12345abcdefghijklmnopqrstuvwxyz`
  // (digit 0 is invalid). Encode the index in base-26 over letters so the
  // suffix is always valid regardless of count.
  const toLetterSuffix = (n: number): string => {
    const letters = "abcdefghijklmnopqrstuvwxyz"
    if (n < letters.length) return letters[n]!
    let s = ""
    let x = n
    while (true) {
      s = letters[x % letters.length]! + s
      x = Math.floor(x / letters.length) - 1
      if (x < 0) break
    }
    return s
  }
  const out: ControlledEthStaker[] = []
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom() as unknown as ethers.HDNodeWallet
    out.push({
      wallet,
      addressHex: wallet.address.toLowerCase().replace(/^0x/, ""),
      totalSourceUnits: perStakerSourceUnits,
      wireAccount: `${wireAccountPrefix}${toLetterSuffix(i)}`
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Synthetic ETH dump
// ---------------------------------------------------------------------------
export interface EthDumpOptions {
  /** Deterministic PRNG seed. Default: 1 (stable across runs). */
  seed?: number
  /** Standalone purchaser rows (no overlap with stakers/controlled). */
  purchaserCount?: number
  /** Standalone staker rows (no overlap with purchasers/controlled). */
  stakerCount?: number
  /**
   * Addresses appearing in BOTH purchasers and stakers — exercises the
   * dedup path in convertImportSeed. Each side contributes a random
   * amount; the converter sums them on raw-bytes keys.
   */
  overlappingCount?: number
  /**
   * Stakers with a non-zero `yieldClaimed` — exercises the netting path
   * `owed = pretokenYield - yieldClaimed`. Includes the case where
   * yieldClaimed > pretokenYield (skipped) by setting it negative
   * relative to yield.
   */
  yieldClaimedCount?: number
  /** Controlled stakers — appended as purchasers (no yieldClaimed). */
  controlled?: ControlledEthStaker[]
  /**
   * Source-decimal magnitude for random amounts. Each random row falls
   * in roughly `[minSourceUnits, 100 * minSourceUnits)`. Default
   * `1e18` (1 ETH-style unit) so the divisor-1e9 conversion produces
   * non-trivial atomic WIRE amounts.
   */
  minSourceUnits?: bigint
}

export function buildSyntheticEthDump(opts: EthDumpOptions = {}): IndexBalanceDump {
  const rng = mulberry32(opts.seed ?? 1)
  const min = opts.minSourceUnits ?? 1_000_000_000_000_000_000n // 1 ETH
  const purchasers: { address: string; totalPretokens: string }[] = []
  const stakers: {
    address: string
    pretokenYield: string
    yieldClaimed?: string
  }[] = []

  // Generate one random 20-byte ETH-style address (lower-case, with 0x).
  const randAddr = (): string => {
    const bytes = new Uint8Array(20)
    for (let i = 0; i < 20; i++) bytes[i] = Math.floor(rng() * 256)
    let s = "0x"
    for (const b of bytes) s += b.toString(16).padStart(2, "0")
    return s
  }
  const randAmt = (): bigint => min + randomBigInt(rng, min * 99n)

  for (let i = 0; i < (opts.purchaserCount ?? 0); i++) {
    purchasers.push({ address: randAddr(), totalPretokens: randAmt().toString() })
  }
  for (let i = 0; i < (opts.stakerCount ?? 0); i++) {
    stakers.push({ address: randAddr(), pretokenYield: randAmt().toString() })
  }
  for (let i = 0; i < (opts.overlappingCount ?? 0); i++) {
    const addr = randAddr()
    purchasers.push({ address: addr, totalPretokens: randAmt().toString() })
    stakers.push({ address: addr, pretokenYield: randAmt().toString() })
  }
  for (let i = 0; i < (opts.yieldClaimedCount ?? 0); i++) {
    const yieldAmt = randAmt()
    const claimed = randomBigInt(rng, yieldAmt / 2n) // partial claim
    stakers.push({
      address: randAddr(),
      pretokenYield: yieldAmt.toString(),
      yieldClaimed: claimed.toString()
    })
  }

  // Controlled stakers always land in purchasers (so dedup logic doesn't
  // suppress them); their totals are fixed via the input spec.
  for (const c of opts.controlled ?? []) {
    purchasers.push({
      address: "0x" + c.addressHex,
      totalPretokens: c.totalSourceUnits.toString()
    })
  }

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
// link/claim path for SVM is owned by a different track; see soak test
// scope notes).
// ---------------------------------------------------------------------------
export interface SolDumpOptions {
  seed?: number
  purchaserCount?: number
  stakerCount?: number
  /** Source decimals on Solana are 9 (lamport-style). Default 1e9. */
  minSourceUnits?: bigint
}

export function buildSyntheticSolDump(opts: SolDumpOptions = {}): IndexBalanceDump {
  const rng = mulberry32(opts.seed ?? 2)
  const min = opts.minSourceUnits ?? 1_000_000_000n // 1 SOL-ish
  const purchasers: { address: string; totalPretokens: string }[] = []
  const stakers: { address: string; pretokenYield: string }[] = []

  // Solana keypairs are 32-byte; address is the base58 of the pubkey.
  // We don't retain the keypair — these are bulk-seed only.
  const randAddr = (): string => Keypair.generate().publicKey.toBase58()
  const randAmt = (): bigint => min + randomBigInt(rng, min * 99n)

  for (let i = 0; i < (opts.purchaserCount ?? 0); i++) {
    purchasers.push({ address: randAddr(), totalPretokens: randAmt().toString() })
  }
  for (let i = 0; i < (opts.stakerCount ?? 0); i++) {
    stakers.push({ address: randAddr(), pretokenYield: randAmt().toString() })
  }
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalMessages: purchasers.length + stakers.length
    },
    purchasers,
    stakers
  }
}
