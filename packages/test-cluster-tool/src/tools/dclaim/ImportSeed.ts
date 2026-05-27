// ImportSeed.ts — TypeScript port of wire-sysio
// contracts/sysio.dclaim/tools/convert_import.py.
//
// Converts an indexer JSON dump (from
// `https://index.wire.foundation/opp/balances` for ETH or
// `https://index.wire.foundation/opp/solana/balances` for SOL) into
// `sysio.dclaim::importseed` action batches.
//
// Schema (verified 2026-05-13):
//   metadata      bookkeeping; ignored by the contract (generatedAt,
//                 totalMessages, yieldDust (ETH only))
//   purchasers[]  {address, totalPretokens, ...}
//                 owed = totalPretokens  (already net of yieldClaimed;
//                 yieldClaimed absent on SOL)
//   stakers[]     {address, pretokenYield, yieldClaimed?, ...}
//                 owed = pretokenYield - (yieldClaimed ?? 0)
//
// Per-chain conventions:
//   CHAIN_KIND_EVM
//     address  0x-prefixed lowercase hex, 20 raw bytes
//     source   18 decimals (wei-style)
//     divisor  10^9  (1e18 → WIRE atomic 1e9)
//   CHAIN_KIND_SVM
//     address  base58 (case-sensitive), 32 raw bytes
//     source   9 decimals (lamport-style; same as WIRE atomic)
//     divisor  1     (no scaling needed)
//
// Per-address conversion:
//   total       = sum(purchaser.totalPretokens)
//               + sum(staker.pretokenYield - (staker.yieldClaimed ?? 0))
//   wire_atomic = floor(total / divisor)         (sub-atomic dust dropped)
//
// Rows with wire_atomic <= 0 are filtered. Output is an array of action
// arg objects (`{chain, credits: [{native_address, wire_atomic}]}`),
// each batched up to `batchSize` credits per call to fit the 150ms /
// 500KB transaction envelope.

import { PublicKey } from "@solana/web3.js"

// ---------------------------------------------------------------------------
// Chain enum names (must match the on-chain `opp::types::ChainKind` proto
// enum values — see proto/sysio/opp/types/types.proto). importseed
// rejects unknown values.
// ---------------------------------------------------------------------------
export type ImportSeedChainKind = "CHAIN_KIND_EVM" | "CHAIN_KIND_SVM"

// ---------------------------------------------------------------------------
// Index data shape
// ---------------------------------------------------------------------------
export interface IndexBalanceMetadata {
  generatedAt?: string
  totalMessages?: number
  /** Indexer-side accumulated dust (ETH only). Not consumed by the contract. */
  yieldDust?: string | number
}

export interface IndexPurchaserRow {
  address: string
  totalPretokens: string | number
  // Other indexer fields exist but are not consumed.
  [key: string]: unknown
}

export interface IndexStakerRow {
  address: string
  pretokenYield: string | number
  yieldClaimed?: string | number
  [key: string]: unknown
}

export interface IndexBalanceDump {
  metadata?: IndexBalanceMetadata
  purchasers?: IndexPurchaserRow[]
  stakers?: IndexStakerRow[]
}

// ---------------------------------------------------------------------------
// importseed action payload shape
// ---------------------------------------------------------------------------
export interface ImportSeedCredit {
  /**
   * Raw native address as a hex string (no `0x` prefix). The dclaim ABI
   * consumes this as `bytes`. ETH = 20 bytes, SOL = 32 bytes.
   */
  native_address: string
  /** WIRE amount in atomic units (9 decimals). */
  wire_atomic: bigint
}

export interface ImportSeedBatch {
  chain: ImportSeedChainKind
  credits: ImportSeedCredit[]
}

export interface ImportSeedResult {
  batches: ImportSeedBatch[]
  /** Sub-atomic units dropped by the floor in `wire_atomic = total / divisor`. */
  droppedDust: bigint
  /** Unique addresses observed (sum of purchasers ∪ stakers after dedup). */
  uniqueAddresses: number
  /** Credits with wire_atomic > 0 after flooring. */
  nonZeroCredits: number
  /** Total WIRE atomic credited across all credits. */
  totalAtomic: bigint
}

// ---------------------------------------------------------------------------
// Address decoders
// ---------------------------------------------------------------------------

/** Decode a `0x`-prefixed or bare hex Ethereum address to 20 raw bytes. */
function ethDecode(addr: string): Uint8Array {
  const stripped = addr.toLowerCase().replace(/^0x/, "")
  if (stripped.length !== 40 || !/^[0-9a-f]+$/.test(stripped)) {
    throw new Error(`invalid ethereum address: ${r(addr)}`)
  }
  const out = new Uint8Array(20)
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Decode a base58 Solana address to 32 raw bytes via @solana/web3.js. */
function solDecode(addr: string): Uint8Array {
  // PublicKey constructor throws on invalid base58 or wrong length.
  return new PublicKey(addr).toBytes()
}

// Quote-like helper for the error messages above to match the Python
// `{x!r}` formatting style without pulling in a dep.
function r(v: unknown): string {
  return JSON.stringify(v)
}

interface ChainConfig {
  decoder: (addr: string) => Uint8Array
  addrLen: number
  /** Source-decimal → WIRE-atomic divisor. */
  divisor: bigint
}

const CHAIN_CONFIG: Record<ImportSeedChainKind, ChainConfig> = {
  CHAIN_KIND_EVM: { decoder: ethDecode, addrLen: 20, divisor: 10n ** 9n },
  CHAIN_KIND_SVM: { decoder: solDecode, addrLen: 32, divisor: 1n }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Lowercase-hex of raw bytes (no `0x` prefix). */
function toHex(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

function toBigInt(v: string | number | undefined, fallback = 0n): bigint {
  if (v === undefined || v === null) return fallback
  if (typeof v === "number") return BigInt(v)
  // Strings from the indexer are decimal integer strings (already
  // converted from the source-chain native unit; no decimal point).
  return BigInt(v)
}

/**
 * Accumulate per-address pretoken totals from the indexer dump.
 * Addresses are normalized to raw bytes at decode time so case /
 * checksum differences collapse to a single key.
 */
function accumulate(
  data: IndexBalanceDump,
  decoder: (s: string) => Uint8Array,
  addrLen: number
): Map<string, bigint> {
  const acc = new Map<string, bigint>()

  const decodeOrThrow = (addr: string): string => {
    const b = decoder(addr)
    if (b.length !== addrLen) {
      throw new Error(
        `address ${r(addr)} decoded to ${b.length} bytes, expected ${addrLen}`
      )
    }
    return toHex(b)
  }

  for (const row of data.purchasers ?? []) {
    const key = decodeOrThrow(row.address)
    acc.set(key, (acc.get(key) ?? 0n) + toBigInt(row.totalPretokens))
  }
  for (const row of data.stakers ?? []) {
    const key = decodeOrThrow(row.address)
    const owed = toBigInt(row.pretokenYield) - toBigInt(row.yieldClaimed, 0n)
    if (owed > 0n) acc.set(key, (acc.get(key) ?? 0n) + owed)
  }
  return acc
}

/**
 * Convert raw `Map<addressHex, total>` into floored WIRE-atomic credits.
 * Returns the credit list and the sub-atomic dust dropped by flooring.
 *
 * Order is stable (sorted by address hex) so two runs against the same
 * input produce identical batches — important for fixture-based testing.
 */
function toCredits(
  accumulator: Map<string, bigint>,
  divisor: bigint
): { credits: ImportSeedCredit[]; droppedDust: bigint } {
  const credits: ImportSeedCredit[] = []
  let droppedDust = 0n
  const keys = [...accumulator.keys()].sort()
  for (const addrHex of keys) {
    const total = accumulator.get(addrHex)!
    const atomic = total / divisor // BigInt floor division
    const dust = total - atomic * divisor
    droppedDust += dust
    if (atomic > 0n) {
      credits.push({ native_address: addrHex, wire_atomic: atomic })
    }
  }
  return { credits, droppedDust }
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`batch size must be > 0; got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ImportSeedOptions {
  /** ChainKind enum name. */
  chain: ImportSeedChainKind
  /**
   * Credits per importseed call. Default 10000 (≈ same as convert_import.py)
   * which fits well inside the 150ms / 500KB transaction envelope. Reduce
   * if you hit transaction size or execution limits at very high user counts.
   */
  batchSize?: number
}

/**
 * Convert an indexer balance dump into importseed batches.
 *
 * @example
 *   const eth = JSON.parse(await fs.readFile("eth-balances.json", "utf8"))
 *   const result = convertImportSeed(eth, { chain: "CHAIN_KIND_EVM" })
 *   for (const batch of result.batches) {
 *     await clio.pushActionAndWait(
 *       "sysio.dclaim",
 *       "importseed",
 *       batch,
 *       "sysio.dclaim@active"
 *     )
 *   }
 */
export function convertImportSeed(
  data: IndexBalanceDump,
  opts: ImportSeedOptions
): ImportSeedResult {
  const cfg = CHAIN_CONFIG[opts.chain]
  if (!cfg) {
    throw new Error(`unknown chain: ${r(opts.chain)}`)
  }
  const batchSize = opts.batchSize ?? 10_000

  const accumulator = accumulate(data, cfg.decoder, cfg.addrLen)
  const { credits, droppedDust } = toCredits(accumulator, cfg.divisor)
  const batches: ImportSeedBatch[] = chunked(credits, batchSize).map(c => ({
    chain: opts.chain,
    credits: c
  }))

  const totalAtomic = credits.reduce(
    (sum, c) => sum + c.wire_atomic,
    0n as bigint
  )

  return {
    batches,
    droppedDust,
    uniqueAddresses: accumulator.size,
    nonZeroCredits: credits.length,
    totalAtomic
  }
}

/**
 * Serialize an `ImportSeedBatch` for clio. BigInts in `wire_atomic` must
 * be emitted as decimal strings — JSON.stringify can't handle BigInt
 * natively, and the dclaim ABI consumes `int64` which accepts string
 * input from JSON.
 */
export function serializeBatchForClio(
  batch: ImportSeedBatch
): { chain: ImportSeedChainKind; credits: { native_address: string; wire_atomic: string }[] } {
  return {
    chain: batch.chain,
    credits: batch.credits.map(c => ({
      native_address: c.native_address,
      wire_atomic: c.wire_atomic.toString()
    }))
  }
}
