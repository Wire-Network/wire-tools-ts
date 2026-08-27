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
 * The numeric value of a slug cell as returned by a v6 KV table read.
 *
 * Depot tables serialize `slug_name` columns as the generated
 * `Sysio<Contract>SlugNameType` `{ value }` wrapper, while some RPC paths hand
 * back the bare number (or its decimal-string spelling). This decoder accepts
 * all four shapes so row filters compare one canonical number.
 *
 * @param raw - The slug cell as returned by a table query (unknown shape).
 * @returns The slug's numeric value, or `Number.NaN` for an unrecognised shape.
 * @example
 *   rows.filter(row => slugValue(row.chain_code) === Number(SlugName.from("ETHEREUM")))
 */
export function slugValue(raw: unknown): number {
  return match(raw)
    .with(P.number, identity)
    .with(P.string, value => Number(value))
    .with({ value: P.number }, wrapped => wrapped.value)
    .with({ value: P.string }, wrapped => Number(wrapped.value))
    .otherwise(() => Number.NaN)
}
