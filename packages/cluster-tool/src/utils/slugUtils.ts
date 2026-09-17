import { SlugName } from "@wireio/sdk-core"
import { identity } from "lodash"
import { match, P } from "ts-pattern"

/** Byte width of a `u64` slug_name PDA seed. */
const SlugNameByteWidth = 8

/** The spelling a `slug_name` of 0 renders as — the depot's absent-code sentinel. */
const ZeroSlugSpelling = ""

/** Packed value of {@link ZeroSlugSpelling}. */
const ZeroSlugValue = 0

/** Digits only — the spelling a packed `u64` takes when JSON quotes it. */
const PackedDecimalPattern = /^[0-9]+$/

/**
 * The packed value held by a transitional `{ value }` wrapper.
 *
 * `fc::json` quotes a `uint64` above `0xffffffff`, so the wrapper's value
 * legitimately arrives as a decimal STRING — but only ever as digits. Anything
 * else is malformed, and `Number()` would coerce it to `NaN` or truncate a
 * fractional spelling rather than reject it. Mirrors the depot's own
 * `checked_packed_value` (`fc/slug_name.hpp`), so both sides of the wire refuse
 * the same shapes.
 *
 * @param value - The wrapper's inner value, as a string.
 * @returns The packed numeric value.
 * @throws If `value` is not an unsigned decimal.
 */
function assertPackedDecimal(value: string): number {
  if (!PackedDecimalPattern.test(value)) {
    throw new Error(
      `slugValue: { value } wrapper must hold an unsigned decimal, got ${JSON.stringify(value)}`
    )
  }
  return Number(value)
}

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
 * The numeric value of a slug cell as returned by a depot KV table read.
 *
 * The carrier is split by ABI shape, which is what removes the ambiguity the
 * previous string-sniffing decoder could not resolve:
 *
 * - A **bare string** is a `slug_name`-typed field, and the depot's ABI builtin
 *   renders it as the decoded slug. It is parsed as a SLUG, never as a decimal.
 *   That matters because the slug alphabet contains digits: `"7"` is a real code
 *   whose packed value is `149533581377536`, and `"101"` / `"1E3"` / `"0X10"`
 *   are ordinary codes that JS numeric syntax silently reinterprets. Preferring
 *   the decimal reading mis-decoded every one of them.
 * - A **`{ value }` wrapper** is the TRANSITIONAL shape a pre-builtin depot
 *   emits, carrying the packed `u64` directly — so its inner value stays
 *   numeric. This arm goes away once no depot emits the wrapper.
 * - A **bare number** is an already-packed value from `SlugName.from` or a
 *   `uint64`-typed code field.
 *
 * Throws on an unrecognised shape rather than returning `Number.NaN`: `NaN`
 * never equals itself, so a `NaN` slug silently matches zero rows in a filter
 * predicate — which surfaces minutes later as a poll timeout instead of at the
 * decode that caused it. An invalid slug spelling throws for the same reason.
 *
 * @param raw - The slug cell as returned by a table query (unknown shape).
 * @returns The slug's packed numeric value.
 * @throws If `raw` is not a recognised slug carrier, or is not a valid slug.
 * @example
 *   rows.filter(row => slugValue(row.chain_code) === SlugName.from("ETHEREUM"))
 */
export function slugValue(raw: unknown): number {
  return match(raw)
    .with(P.number, identity)
    .with(ZeroSlugSpelling, () => ZeroSlugValue)
    .with(P.string, spelling => SlugName.from(spelling))
    .with({ value: P.number }, wrapped => wrapped.value)
    .with({ value: P.string }, wrapped => assertPackedDecimal(wrapped.value))
    .otherwise(value => {
      throw new Error(
        `slugValue: unrecognised slug carrier (${typeof value}) — expected a number, a slug spelling, or a { value } wrapper`
      )
    })
}
