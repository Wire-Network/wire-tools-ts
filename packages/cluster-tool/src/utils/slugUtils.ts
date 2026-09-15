import { SlugName } from "@wireio/sdk-core"
import { identity } from "lodash"
import { match, P } from "ts-pattern"

/** Byte width of a `u64` slug_name PDA seed. */
const SlugNameByteWidth = 8

/**
 * Encode a `slug_name` as the 8-byte little-endian buffer used by Solana
 * programs' `to_le_bytes()` PDA seeds. Every scoped seed leg goes through
 * this — token codes AND reserve codes alike.
 *
 * Both carriers are accepted because both occur: `SlugName.from()` and
 * {@link slugValue} yield `number` (a slug_name packs into 48 bits, well under
 * `Number.MAX_SAFE_INTEGER`), while the generated deposit / swap inputs carry
 * the `u64` as `bigint`. Widening once here keeps every call site free of a
 * `BigInt(...)` wrapper.
 *
 * @param value - The slug_name to encode (a token code, a reserve code, …).
 * @returns An 8-byte little-endian buffer.
 */
export function slugNameToLittleEndianBuffer(value: number | bigint): Buffer {
  const buffer = Buffer.alloc(SlugNameByteWidth)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

/**
 * Decode the string spelling of a slug cell.
 *
 * Two different renderings arrive as strings and the shape cannot tell them
 * apart: a `slug_name`-typed field renders as the decoded slug (`"ETH"`) once
 * the depot registers the ABI builtin, while a bare-`uint64` code field renders
 * as its decimal spelling (`"84606581215232"`). The decimal reading is
 * preferred, with a slug parse as the fallback.
 *
 * TRANSITIONAL. An all-digit slug (`"101"`) is therefore read as a decimal
 * rather than as the slug literal — an ambiguity no string-sniffing decoder can
 * resolve, because the slug alphabet contains digits. This exists only to span
 * the window in which the depot and this harness disagree about the carrier;
 * the correct fix is to split this decoder by the field's ABI carrier, after
 * which this helper and both string arms below are deleted.
 *
 * @param value - The string spelling of a slug cell.
 * @returns The slug's numeric value.
 */
function decodeSlugString(value: string): number {
  const packed = Number(value)
  return Number.isNaN(packed) ? SlugName.from(value) : packed
}

/**
 * The numeric value of a slug cell as returned by a v6 KV table read.
 *
 * Depot tables serialize `slug_name` columns as the generated
 * `Sysio<Contract>SlugNameType` `{ value }` wrapper, while some RPC paths hand
 * back the bare number (or its decimal-string spelling), and a depot carrying
 * the `slug_name` ABI builtin renders the decoded slug instead. This decoder
 * accepts every shape so row filters compare one canonical number.
 *
 * Throws on an unrecognised shape rather than returning `Number.NaN`: `NaN`
 * never equals itself, so a `NaN` slug silently matches zero rows in a filter
 * predicate — which surfaces minutes later as a poll timeout instead of at the
 * decode that caused it.
 *
 * @param raw - The slug cell as returned by a table query (unknown shape).
 * @returns The slug's numeric value.
 * @throws If `raw` is not a recognised slug carrier.
 * @example
 *   rows.filter(row => slugValue(row.chain_code) === SlugName.from("ETHEREUM"))
 */
export function slugValue(raw: unknown): number {
  return match(raw)
    .with(P.number, identity)
    .with(P.string, decodeSlugString)
    .with({ value: P.number }, wrapped => wrapped.value)
    .with({ value: P.string }, wrapped => decodeSlugString(wrapped.value))
    .otherwise(value => {
      throw new Error(
        `slugValue: unrecognised slug carrier (${typeof value}) — expected a number, a decimal string, a slug literal, or a { value } wrapper`
      )
    })
}
