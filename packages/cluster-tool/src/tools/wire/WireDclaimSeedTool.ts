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

import Assert from "node:assert"

import { PublicKey } from "@solana/web3.js"
import { match } from "ts-pattern"
import { z } from "zod"

import { ChainKind } from "@wireio/opp-typescript-models"
import { NestedError } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"

import type { DistributionClaimBootstrapCredit } from "../../types/DistributionClaimBootstrap.js"
import { abiEnumValue } from "../../utils/enumUtils.js"

// ---------------------------------------------------------------------------
// Chain kinds — the proto `ChainKind` subset importseed accepts (see
// proto/sysio/opp/types/types.proto). importseed rejects unknown values.
// ---------------------------------------------------------------------------
/** The chain kinds `importseed` accepts — a proto `ChainKind` subset. */
export type ImportSeedChainKind = ChainKind.EVM | ChainKind.SVM

/**
 * Return whether a value is a native chain accepted by `importseed`.
 *
 * @param value - Candidate proto chain-kind value.
 * @returns Whether the value is the EVM or SVM chain kind.
 */
export function isImportSeedChainKind(
  value: unknown
): value is ImportSeedChainKind {
  return value === ChainKind.EVM || value === ChainKind.SVM
}

/** Runtime validation for the generated proto subset accepted by `importseed`. */
export const ImportSeedChainKindSchema = z.custom<ImportSeedChainKind>(
  isImportSeedChainKind,
  "must be the EVM or SVM ChainKind"
)

enum IndexBalanceSection {
  purchasers = "purchasers",
  stakers = "stakers"
}

enum IndexBalanceField {
  totalPretokens = "totalPretokens",
  pretokenYield = "pretokenYield"
}

/** Ethereum native-address width consumed by dclaim. */
const EthereumNativeAddressByteLength = 20
/** Solana native-address width consumed by dclaim. */
const SolanaNativeAddressByteLength = 32
/** Maximum credits per `importseed` call within the transaction envelope. */
const MaxImportSeedBatchSize = 10_000
/** `asset::max_amount`, enforced when dclaim constructs a claim balance. */
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
    /** Indexer-side accumulated dust. It is not consumed by the contract. */
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
 * Runtime schema for indexer balance-dump fields consumed by `sysio.dclaim`.
 * Unrelated fields pass through so indexer schema additions remain compatible.
 */
export const IndexBalanceDumpSchema = z
  .object({
    metadata: IndexBalanceMetadataSchema.optional(),
    purchasers: z.array(IndexPurchaserRowSchema).optional(),
    stakers: z.array(IndexStakerRowSchema).optional()
  })
  .passthrough()

/** Schema-derived metadata consumed from an indexer balance dump. */
export type IndexBalanceMetadata = z.infer<typeof IndexBalanceMetadataSchema>
/** Schema-derived purchaser row consumed from an indexer balance dump. */
export type IndexPurchaserRow = z.infer<typeof IndexPurchaserRowSchema>
/** Schema-derived staker row consumed from an indexer balance dump. */
export type IndexStakerRow = z.infer<typeof IndexStakerRowSchema>
/** Schema-derived indexer balance-dump input. */
export type IndexBalanceDump = z.infer<typeof IndexBalanceDumpSchema>

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

// ---------------------------------------------------------------------------
// importseed action payload shape
// ---------------------------------------------------------------------------
/** Runtime schema for one normalized `sysio.dclaim::importseed` credit. */
export const ImportSeedCreditSchema: z.ZodType<DistributionClaimBootstrapCredit> =
  z.object({
    /**
     * Raw native address as a hex string (no `0x` prefix). The dclaim ABI
     * consumes this as `bytes`. ETH = 20 bytes, SOL = 32 bytes.
     */
    native_address: z.string().regex(/^(?:[0-9a-f]{2})+$/),
    /** WIRE amount in atomic units (9 decimals). */
    wire_atomic: z.bigint().positive().max(MaxImportSeedWireAtomic)
  })
/** One normalized `sysio.dclaim::importseed` credit. */
export type ImportSeedCredit = DistributionClaimBootstrapCredit

/** Runtime schema for normalized credits belonging to one native chain. */
export const ImportSeedCreditSetSchema = z
  .object({
    chain: ImportSeedChainKindSchema,
    credits: z.array(ImportSeedCreditSchema)
  })
  .superRefine((creditSet, context) => {
    const expectedHexLength = CHAIN_CONFIG[creditSet.chain].addrLen * 2
    creditSet.credits.forEach((credit, index) => {
      if (credit.native_address.length !== expectedHexLength) {
        context.addIssue({
          code: "custom",
          path: ["credits", index, "native_address"],
          message: `${importSeedChainLabel(creditSet.chain)} native address must be ${expectedHexLength / 2} bytes`
        })
      }
    })
  })

/** Runtime schema for one transaction-sized `sysio.dclaim::importseed` batch. */
export const ImportSeedBatchSchema = ImportSeedCreditSetSchema.safeExtend({
  credits: z.array(ImportSeedCreditSchema).min(1).max(MaxImportSeedBatchSize)
})
/** One transaction-sized `sysio.dclaim::importseed` batch. */
export type ImportSeedBatch = z.infer<typeof ImportSeedBatchSchema>

/** Deterministic credits and conversion statistics before batching. */
export interface ImportSeedConversion {
  /** Address-sorted credits with positive WIRE-atomic balances. */
  credits: ImportSeedCredit[]
  /** Sub-atomic units dropped by the floor in `wire_atomic = total / divisor`. */
  droppedDust: bigint
  /** Unique addresses retained after non-positive staker yields are filtered. */
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
function decodeEthereumAddress(addr: string): Uint8Array {
  const stripped = addr.toLowerCase().replace(/^0x/, "")
  if (stripped.length !== 40 || !/^[0-9a-f]+$/.test(stripped)) {
    throw new Error(`invalid ethereum address: ${r(addr)}`)
  }
  return Uint8Array.from({ length: 20 }, (_, index) =>
    parseInt(stripped.slice(index * 2, index * 2 + 2), 16)
  )
}

/** Decode a base58 Solana address to 32 raw bytes via @solana/web3.js. */
function decodeSolanaAddress(addr: string): Uint8Array {
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
    decoder: decodeEthereumAddress,
    addrLen: EthereumNativeAddressByteLength,
    divisor: 10n ** 9n
  },
  [ChainKind.SVM]: {
    decoder: decodeSolanaAddress,
    addrLen: SolanaNativeAddressByteLength,
    divisor: 1n
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Lowercase-hex of raw bytes (no `0x` prefix). */
function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
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
  data: DeepReadonly<IndexBalanceDump>,
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

  const { purchasers = [], stakers = [] } = data
  purchasers.forEach(row => {
    const key = decodeOrThrow(row.address)
    acc.set(key, (acc.get(key) ?? 0n) + toBigInt(row.totalPretokens))
  })
  stakers.forEach(row => {
    const key = decodeOrThrow(row.address)
    const owed = toBigInt(row.pretokenYield) - toBigInt(row.yieldClaimed, 0n)
    if (owed > 0n) acc.set(key, (acc.get(key) ?? 0n) + owed)
  })
  return acc
}

/**
 * What {@link toCredits} produces: the floored per-address credit list plus the
 * sub-atomic dust the flooring dropped. Both roll up into
 * {@link ImportSeedResult}.
 */
interface ImportSeedCreditResult {
  credits: ImportSeedCredit[]
  /** Sub-atomic units dropped by the floor in `wire_atomic = total / divisor`. */
  droppedDust: bigint
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
): ImportSeedCreditResult {
  const credits: ImportSeedCredit[] = [],
    entries = [...accumulator.entries()].sort(([left], [right]) =>
      compareAddressHex(left, right)
    )
  let droppedDust = 0n
  entries.forEach(([native_address, total]) => {
    const wire_atomic = total / divisor,
      dust = total - wire_atomic * divisor
    droppedDust += dust
    if (wire_atomic > 0n) {
      credits.push({ native_address, wire_atomic })
    }
  })
  return { credits, droppedDust }
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MaxImportSeedBatchSize)
    throw new Error(
      `batch size must be a safe integer between 1 and ${MaxImportSeedBatchSize}; got ${size}`
    )
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, index) =>
    arr.slice(index * size, (index + 1) * size)
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Native-chain and transaction-batching options for indexer-dump conversion. */
export interface ImportSeedOptions {
  /** ChainKind enum name. */
  chain: ImportSeedChainKind
  /**
   * Credits per importseed call. Default and maximum 10000 (approximately the
   * same as convert_import.py), bounded by the transaction envelope.
   */
  batchSize?: number
}

/** Context attached to indexer validation failures. */
export interface IndexBalanceDumpValidationContext {
  /** Native chain whose address and decimal rules apply. */
  chain: ImportSeedChainKind
  /** Human-readable provenance such as an absolute file path. */
  source: string
}

const ValidatedIndexBalanceDumpBrand = Symbol("ValidatedIndexBalanceDump")

interface ValidatedIndexBalanceDumpProof {
  readonly data: DeepReadonly<IndexBalanceDump>
  readonly context: DeepReadonly<IndexBalanceDumpValidationContext>
}

/** Validated indexer data coupled to one immutable chain and source context. */
export interface ValidatedIndexBalanceDump {
  /** Schema-validated dump contents, isolated from the caller's input. */
  readonly data: DeepReadonly<IndexBalanceDump>
  /** Chain and provenance used for address and balance-limit validation. */
  readonly context: DeepReadonly<IndexBalanceDumpValidationContext>
  /** Private proof that this value came from {@link validateIndexBalanceDump}. */
  readonly [ValidatedIndexBalanceDumpBrand]: ValidatedIndexBalanceDumpProof
}

/**
 * Validate an untrusted indexer balance dump without performing file I/O.
 *
 * Errors retain chain, source, row, and field context so callers can report a
 * precise preflight failure before any cluster side effect begins.
 *
 * @param value - Untrusted parsed JSON value.
 * @param context - Native chain and provenance label.
 * @returns The schema-validated dump coupled to its chain and provenance.
 */
export function validateIndexBalanceDump(
  value: unknown,
  context: IndexBalanceDumpValidationContext
): ValidatedIndexBalanceDump {
  const validatedContext = {
      ...context,
      chain: ImportSeedChainKindSchema.parse(context.chain)
    },
    parsed = IndexBalanceDumpSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0],
      row = issue.path.find(segment => typeof segment === "number")
    throw new NestedError(
      `${importSeedChainLabel(validatedContext.chain)} bootstrap data validation failed`,
      {
        cause: parsed.error,
        context: {
          chain: validatedContext.chain,
          source: validatedContext.source,
          ...(row == null ? {} : { row }),
          field: formatIssuePath(issue.path),
          issue: issue.message
        }
      }
    )
  }
  validateDumpRows(parsed.data, validatedContext)
  const data = parsed.data,
    frozenContext = Object.freeze(validatedContext),
    proof = Object.freeze({ data, context: frozenContext })
  return Object.freeze({
    data,
    context: frozenContext,
    [ValidatedIndexBalanceDumpBrand]: proof
  })
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
  const validated = validateIndexBalanceDump(data, {
    chain,
    source: "in-memory indexer balance dump"
  })
  return convertValidatedImportSeedCredits(validated)
}

/**
 * Convert an already-validated indexer dump without repeating schema,
 * provenance-aware address, or balance-limit validation.
 *
 * Callers that need errors to retain a real file or endpoint source should
 * first call {@link validateIndexBalanceDump}, then pass its return value here.
 *
 * @param validated - Dump, chain, and source returned by
 *   {@link validateIndexBalanceDump}.
 * @returns Credits plus conversion statistics.
 */
export function convertValidatedImportSeedCredits(
  validated: ValidatedIndexBalanceDump
): ImportSeedConversion {
  const proof = validated[ValidatedIndexBalanceDumpBrand]
  if (
    proof == null ||
    proof.data !== validated.data ||
    proof.context !== validated.context
  ) {
    throw new Error(
      "convertValidatedImportSeedCredits requires validateIndexBalanceDump output"
    )
  }
  const { data, context } = validated,
    { chain } = context,
    cfg = CHAIN_CONFIG[chain]
  if (!cfg) {
    throw new Error(`unknown chain: ${r(chain)}`)
  }

  const accumulator = accumulate(data, cfg.decoder, cfg.addrLen),
    { credits, droppedDust } = toCredits(accumulator, cfg.divisor),
    totalAtomic = credits.reduce((sum, credit) => sum + credit.wire_atomic, 0n)
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
  const { batchSize = MaxImportSeedBatchSize } = options
  return chunked([...credits], batchSize).map(batchCredits => ({
    chain: options.chain,
    credits: batchCredits
  }))
}

/**
 * Merge credit sets by normalized native-address hex.
 *
 * @param creditSets - Converted or programmatically supplied credit sets.
 * @param chain - Native chain whose address width must be enforced.
 * @returns A fresh address-sorted list with duplicate addresses summed.
 */
export function mergeImportSeedCredits(
  creditSets: readonly (readonly ImportSeedCredit[])[],
  chain: ImportSeedChainKind
): ImportSeedCredit[] {
  const config = CHAIN_CONFIG[chain]
  if (!config) {
    throw new Error(`unknown chain: ${r(chain)}`)
  }
  const expectedHexLength = config.addrLen * 2,
    merged = new Map<string, bigint>()
  creditSets.flat().forEach(credit => {
    if (
      credit.native_address.length !== expectedHexLength ||
      !/^[0-9a-f]+$/.test(credit.native_address)
    ) {
      throw new Error(
        `${importSeedChainLabel(chain)} importseed native_address must be ${config.addrLen} bytes of lowercase hex without 0x; got ${r(credit.native_address)}`
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
  })
  const credits = [...merged.entries()]
    .sort(([left], [right]) => compareAddressHex(left, right))
    .map(([native_address, wire_atomic]) => ({ native_address, wire_atomic }))
  credits.forEach(credit => {
    if (credit.wire_atomic > MaxImportSeedWireAtomic) {
      throw new Error(
        `${importSeedChainLabel(chain)} importseed wire_atomic exceeds asset maximum for ${r(credit.native_address)}; got ${credit.wire_atomic}, maximum ${MaxImportSeedWireAtomic}`
      )
    }
  })
  return credits
}

/** Compare normalized address hex by locale-independent code units. */
function compareAddressHex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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
 *
 * @param data - Indexer balance dump to validate and convert.
 * @param opts - Native chain and optional transaction batch size.
 * @returns Deterministic credits, conversion statistics, and importseed batches.
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
 *
 * @param batch - Validated transaction-sized importseed batch.
 * @returns The clio-ready action payload with decimal-string amounts.
 */
export function serializeBatchForClio(
  batch: ImportSeedBatch
): SysioContracts.SysioDclaimImportseedAction {
  Assert.ok(
    batch.credits.length > 0 && batch.credits.length <= MaxImportSeedBatchSize,
    `importseed batch must contain between 1 and ${MaxImportSeedBatchSize} credits`
  )
  return {
    // proto ChainKind → the dclaim ABI's own enum, bridged by VALUE.
    chain: abiEnumValue(SysioContracts.SysioDclaimChainkind, batch.chain),
    credits: batch.credits.map(c => ({
      native_address: c.native_address,
      wire_atomic: c.wire_atomic.toString()
    }))
  }
}

/**
 * Return the human-readable native-chain label used in importseed errors.
 *
 * @param chain - Supported native chain kind.
 * @returns The Ethereum or Solana label.
 */
export function importSeedChainLabel(chain: ImportSeedChainKind): string {
  return match(chain)
    .with(ChainKind.EVM, () => "Ethereum")
    .with(ChainKind.SVM, () => "Solana")
    .otherwise(unsupportedChain => {
      throw new Error(`unknown chain: ${r(unsupportedChain)}`)
    })
}

function validateDumpRows(
  data: IndexBalanceDump,
  context: IndexBalanceDumpValidationContext
): void {
  const config = CHAIN_CONFIG[context.chain],
    totals = new Map<string, bigint>(),
    { purchasers = [], stakers = [] } = data
  const validateRow = (
    row: IndexPurchaserRow | IndexStakerRow,
    index: number,
    section: IndexBalanceSection,
    field: IndexBalanceField,
    sourceAmount: bigint
  ): void => {
    let bytes: Uint8Array
    try {
      bytes = config.decoder(row.address)
      if (bytes.length !== config.addrLen) {
        throw new Error(
          `decoded to ${bytes.length} bytes, expected ${config.addrLen}`
        )
      }
    } catch (error) {
      throw new NestedError(
        `${importSeedChainLabel(context.chain)} bootstrap data address validation failed`,
        {
          cause: error,
          context: {
            chain: context.chain,
            source: context.source,
            row: index,
            field: `${section}[${index}].address`
          }
        }
      )
    }
    if (sourceAmount <= 0n) return
    const address = toHex(bytes),
      sourceTotal = (totals.get(address) ?? 0n) + sourceAmount,
      wireAtomic = sourceTotal / config.divisor
    if (wireAtomic > MaxImportSeedWireAtomic) {
      throw new NestedError(
        `${importSeedChainLabel(context.chain)} bootstrap data converted balance exceeds asset maximum`,
        {
          cause: new Error(
            `converted wire_atomic ${wireAtomic} exceeds ${MaxImportSeedWireAtomic}`
          ),
          context: {
            chain: context.chain,
            source: context.source,
            row: index,
            field: `${section}[${index}].${field}`,
            address: row.address,
            wireAtomic,
            maximum: MaxImportSeedWireAtomic
          }
        }
      )
    }
    totals.set(address, sourceTotal)
  }
  purchasers.forEach((row, index) => {
    validateRow(
      row,
      index,
      IndexBalanceSection.purchasers,
      IndexBalanceField.totalPretokens,
      toBigInt(row.totalPretokens)
    )
    Object.freeze(row)
  })
  stakers.forEach((row, index) => {
    validateRow(
      row,
      index,
      IndexBalanceSection.stakers,
      IndexBalanceField.pretokenYield,
      toBigInt(row.pretokenYield) - toBigInt(row.yieldClaimed, 0n)
    )
    Object.freeze(row)
  })
  Object.freeze(purchasers)
  Object.freeze(stakers)
  Object.freeze(data)
}

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "root"
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`
    const property = String(segment)
    return result.length === 0 ? property : `${result}.${property}`
  }, "")
}
