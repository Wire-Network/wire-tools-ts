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

import Fs from "node:fs/promises"
import { PublicKey } from "@solana/web3.js"
import { ChainKind } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { z } from "zod"
import { abiEnumValue } from "../../utils/enumUtils.js"

// ---------------------------------------------------------------------------
// Chain kinds — the proto `ChainKind` subset importseed accepts (see
// proto/sysio/opp/types/types.proto). importseed rejects unknown values.
// ---------------------------------------------------------------------------
/** The chain kinds `importseed` accepts — a proto `ChainKind` subset. */
export type ImportSeedChainKind = ChainKind.EVM | ChainKind.SVM

enum IndexBalanceSection {
  Purchasers = "purchasers",
  Stakers = "stakers"
}

/** Credits per `importseed` call — fits the 150ms / 500KB transaction envelope. */
const DefaultImportSeedBatchSize = 10_000
/** `asset::max_amount`, enforced when dclaim constructs the claim balance. */
const MaxImportSeedWireAtomic = (1n << 62n) - 1n

// ---------------------------------------------------------------------------
// Index data shape
// ---------------------------------------------------------------------------
const NonNegativeIntegerSchema = z.union([
  z.string().regex(/^\d+$/, "must be a non-negative decimal integer string"),
  z.number().safe().int().nonnegative()
])

const IndexBalanceMetadataSchema = z
  .object({
    generatedAt: z.string().optional(),
    totalMessages: z.number().safe().int().nonnegative().optional(),
    /** Indexer-side accumulated dust (ETH only). Not consumed by the contract. */
    yieldDust: NonNegativeIntegerSchema.optional()
  })
  .passthrough()

const IndexPurchaserRowSchema = z
  .object({
    address: z.string().min(1),
    totalPretokens: NonNegativeIntegerSchema
  })
  .passthrough()

const IndexStakerRowSchema = z
  .object({
    address: z.string().min(1),
    pretokenYield: NonNegativeIntegerSchema,
    yieldClaimed: NonNegativeIntegerSchema.optional()
  })
  .passthrough()

/**
 * Runtime schema for the indexer balance-dump fields consumed by
 * `sysio.dclaim`. Unknown indexer metadata and row fields are retained so
 * schema evolution outside this importer remains backward-compatible.
 */
export const IndexBalanceDumpSchema = z
  .object({
    metadata: IndexBalanceMetadataSchema.optional(),
    purchasers: z.array(IndexPurchaserRowSchema).optional(),
    stakers: z.array(IndexStakerRowSchema).optional()
  })
  .passthrough()

/** Schema-derived metadata fields consumed from an indexer balance dump. */
export type IndexBalanceMetadata = z.infer<typeof IndexBalanceMetadataSchema>
/** Schema-derived purchaser row consumed from an indexer balance dump. */
export type IndexPurchaserRow = z.infer<typeof IndexPurchaserRowSchema>
/** Schema-derived staker row consumed from an indexer balance dump. */
export type IndexStakerRow = z.infer<typeof IndexStakerRowSchema>
/** Schema-derived indexer balance-dump input. */
export type IndexBalanceDump = z.infer<typeof IndexBalanceDumpSchema>

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

/** Deterministic credits and conversion statistics before transaction batching. */
export interface ImportSeedConversion {
  /** Address-sorted credits with `wire_atomic > 0`. */
  credits: ImportSeedCredit[]
  /** Sub-atomic units dropped by the floor in `wire_atomic = total / divisor`. */
  droppedDust: bigint
  /** Unique addresses observed (sum of purchasers ∪ stakers after dedup). */
  uniqueAddresses: number
  /** Credits with wire_atomic > 0 after flooring. */
  nonZeroCredits: number
  /** Total WIRE atomic credited across all credits. */
  totalAtomic: bigint
}

/** A conversion plus its transaction-sized `importseed` batches. */
export interface ImportSeedResult extends ImportSeedConversion {
  batches: ImportSeedBatch[]
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
  [ChainKind.EVM]: {
    decoder: ethDecode,
    addrLen: 20,
    divisor: 10n ** 9n
  },
  [ChainKind.SVM]: {
    decoder: solDecode,
    addrLen: 32,
    divisor: 1n
  }
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
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`expected a non-negative safe integer; got ${r(v)}`)
    }
    return BigInt(v)
  }
  // Strings from the indexer are decimal integer strings (already
  // converted from the source-chain native unit; no decimal point).
  if (!/^\d+$/.test(v)) {
    throw new Error(
      `expected a non-negative decimal integer string; got ${r(v)}`
    )
  }
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
 * Read and validate an indexer balance dump for one native chain.
 *
 * Errors identify the chain, file, row, and field whenever that context exists,
 * so malformed launch inputs fail before any cluster process or action starts.
 *
 * @param file - Absolute or caller-resolved JSON input path.
 * @param chain - Native chain whose address rules apply.
 * @returns The validated balance dump.
 */
export async function loadIndexBalanceDump(
  file: string,
  chain: ImportSeedChainKind
): Promise<IndexBalanceDump> {
  const label = chainLabel(chain)
  let contents: string
  try {
    contents = await Fs.readFile(file, "utf8")
  } catch (error) {
    throw new Error(
      `${label} bootstrap file ${r(file)}: unable to read: ${errorMessage(error)}`,
      { cause: error }
    )
  }

  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(
      `${label} bootstrap file ${r(file)}: invalid JSON: ${errorMessage(error)}`,
      { cause: error }
    )
  }

  const parsed = IndexBalanceDumpSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `${label} bootstrap file ${r(file)}: ${formatIssuePath(issue.path)}: ${issue.message}`
    )
  }

  const dump = parsed.data
  validateDumpAddresses(dump, chain, file)
  return dump
}

/**
 * Convert an indexer dump into deterministic address-sorted credits without
 * choosing a transaction batch size.
 *
 * @param data - Validated or caller-constructed indexer balance dump.
 * @param chain - Native chain controlling address and decimal conversion.
 * @returns Credits plus conversion statistics.
 */
export function convertImportSeedCredits(
  data: IndexBalanceDump,
  chain: ImportSeedChainKind
): ImportSeedConversion {
  const cfg = CHAIN_CONFIG[chain]
  if (!cfg) {
    throw new Error(`unknown chain: ${r(chain)}`)
  }

  const accumulator = accumulate(data, cfg.decoder, cfg.addrLen)
  const { credits, droppedDust } = toCredits(accumulator, cfg.divisor)
  const totalAtomic = credits.reduce(
    (sum, credit) => sum + credit.wire_atomic,
    0n
  )
  return {
    credits,
    droppedDust,
    uniqueAddresses: accumulator.size,
    nonZeroCredits: credits.length,
    totalAtomic
  }
}

/**
 * Split already-converted credits into deterministic action batches.
 *
 * @param credits - Address-sorted credits for one chain.
 * @param options - Chain plus optional credits-per-action limit.
 * @returns Transaction-sized `importseed` payloads.
 */
export function batchImportSeedCredits(
  credits: readonly ImportSeedCredit[],
  options: ImportSeedOptions
): ImportSeedBatch[] {
  const { batchSize = DefaultImportSeedBatchSize } = options
  return chunked([...credits], batchSize).map(batchCredits => ({
    chain: options.chain,
    credits: batchCredits
  }))
}

/**
 * Merge additive credit sets by normalized native-address hex.
 *
 * @param creditSets - Any number of converted or scenario-provided credit sets.
 * @param chain - Native chain whose ABI address width must be enforced.
 * @returns A fresh address-sorted credit list with duplicate addresses summed.
 */
export function mergeImportSeedCredits(
  creditSets: readonly (readonly ImportSeedCredit[])[],
  chain: ImportSeedChainKind
): ImportSeedCredit[] {
  const cfg = CHAIN_CONFIG[chain]
  if (!cfg) {
    throw new Error(`unknown chain: ${r(chain)}`)
  }
  const expectedHexLength = cfg.addrLen * 2
  const merged = new Map<string, bigint>()
  for (const credits of creditSets) {
    for (const credit of credits) {
      if (
        credit.native_address.length !== expectedHexLength ||
        !/^[0-9a-f]+$/.test(credit.native_address)
      ) {
        throw new Error(
          `${chainLabel(chain)} importseed native_address must be ${cfg.addrLen} bytes of lowercase hex without 0x; got ${r(credit.native_address)}`
        )
      }
      if (credit.wire_atomic <= 0n) {
        throw new Error(
          `importseed wire_atomic must be positive for ${r(credit.native_address)}; got ${credit.wire_atomic}`
        )
      }
      merged.set(
        credit.native_address,
        (merged.get(credit.native_address) ?? 0n) + credit.wire_atomic
      )
    }
  }
  const credits = [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([native_address, wire_atomic]) => ({
      native_address,
      wire_atomic
    }))
  for (const credit of credits) {
    if (credit.wire_atomic > MaxImportSeedWireAtomic) {
      throw new Error(
        `${chainLabel(chain)} importseed wire_atomic exceeds asset maximum for ${r(credit.native_address)}; got ${credit.wire_atomic}, maximum ${MaxImportSeedWireAtomic}`
      )
    }
  }
  return credits
}

/**
 * Convert an indexer balance dump into importseed batches.
 *
 * @example
 *   const eth = JSON.parse(await fs.readFile("eth-balances.json", "utf8"))
 *   const result = convertImportSeed(eth, { chain: ChainKind.EVM })
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
  const conversion = convertImportSeedCredits(data, opts.chain)
  return {
    ...conversion,
    batches: batchImportSeedCredits(conversion.credits, opts)
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
): SysioContracts.SysioDclaimImportseedAction {
  return {
    // proto ChainKind → the dclaim ABI's own enum, bridged by VALUE.
    chain: abiEnumValue(SysioContracts.SysioDclaimChainkind, batch.chain),
    credits: batch.credits.map(c => ({
      native_address: c.native_address,
      wire_atomic: c.wire_atomic.toString()
    }))
  }
}

function chainLabel(chain: ImportSeedChainKind): string {
  if (chain === ChainKind.EVM) return "Ethereum"
  if (chain === ChainKind.SVM) return "Solana"
  return `chain ${chain}`
}

function validateDumpAddresses(
  data: IndexBalanceDump,
  chain: ImportSeedChainKind,
  file: string
): void {
  const config = CHAIN_CONFIG[chain]
  const validateRows = (
    rows: readonly (IndexPurchaserRow | IndexStakerRow)[],
    section: IndexBalanceSection
  ): void => {
    rows.forEach((row, index) => {
      try {
        const bytes = config.decoder(row.address)
        if (bytes.length !== config.addrLen) {
          throw new Error(
            `decoded to ${bytes.length} bytes, expected ${config.addrLen}`
          )
        }
      } catch (error) {
        throw new Error(
          `${chainLabel(chain)} bootstrap file ${r(file)}: ${section}[${index}].address: ${errorMessage(error)}`,
          { cause: error }
        )
      }
    })
  }
  validateRows(data.purchasers ?? [], IndexBalanceSection.Purchasers)
  validateRows(data.stakers ?? [], IndexBalanceSection.Stakers)
}

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "root"
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`
    const property = String(segment)
    return result.length === 0 ? property : `${result}.${property}`
  }, "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
