import { match, P } from "ts-pattern"

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
    .with(P.number, value => value)
    .with(P.string, value => Number(value))
    .with({ value: P.number }, wrapped => wrapped.value)
    .with({ value: P.string }, wrapped => Number(wrapped.value))
    .otherwise(() => Number.NaN)
}
