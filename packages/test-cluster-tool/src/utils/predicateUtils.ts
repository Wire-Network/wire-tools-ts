import { isEmpty, negate } from "lodash"
import { match, P } from "ts-pattern"

/**
 * True when `value` is not empty — the negation of lodash `isEmpty`. Treats
 * `""`, `[]`, `{}`, `null`, and `undefined` as empty.
 *
 * @param value - The value to test.
 * @returns Whether `value` is non-empty.
 */
export const isNotEmpty: (value: unknown) => boolean = negate(isEmpty)

/**
 * True when `min <= value <= max` (inclusive on both ends).
 *
 * @param value - The number to test.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound. Defaults to {@link Number.MAX_SAFE_INTEGER}.
 * @returns Whether `value` lies within `[min, max]`.
 */
export function inRange(
  value: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): boolean {
  return value >= min && value <= max
}

/**
 * Match a depot-table enum cell against an expected proto-enum member.
 *
 * chain_plugin's get-table JSON may carry an enum cell as the numeric value
 * (`3`), the numeric value as a string (`"3"`), or the proto-spelling string
 * (`"OPERATOR_STATUS_ACTIVE"`) depending on the serialization path. The
 * `SysioContracts` proto enums use the full proto spelling as the member
 * name, so the enum's reverse mapping `enumObj[want]` IS the wire string —
 * pass those enums here, never a hand-rolled `{ NAME: value }` table.
 *
 * @param raw - The cell as returned by `getTableRows` (unknown shape).
 * @param enumObj - The generated proto enum (e.g. `SysioOpregOperatorstatus`).
 * @param want - The member to test for (e.g. `OPERATOR_STATUS_ACTIVE`).
 * @returns Whether `raw` denotes `want` under any of the three spellings.
 * @example
 *   matchesProtoEnum(row.status, SysioChalgDisputestatus, SysioChalgDisputestatus.DISPUTE_STATUS_OPEN)
 */
export function matchesProtoEnum(
  raw: unknown,
  enumObj: Record<string | number, string | number>,
  want: number
): boolean {
  return match(raw)
    .with(P.number, n => n === want)
    .with(P.string, s => s === enumObj[want] || Number(s) === want)
    .otherwise(() => false)
}
