import type { RunEvidenceDecimal } from "@wireio/test-opp-stress"

/**
 * Narrow one unknown value to a non-array record.
 * @param value Unknown snapshotted evidence value.
 * @returns Whether the value is a record.
 */
export function isObservationRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Require an exact enumerable string-key collection.
 * @param value Snapshotted record under validation.
 * @param keys Complete allowed key collection.
 * @returns Whether the record has exactly those keys.
 */
export function hasExactObservationKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value)
  return (
    actual.length === keys.length &&
    actual.every(key => typeof key === "string" && keys.includes(key)) &&
    keys.every(key => actual.includes(key))
  )
}

/**
 * Narrow one value to a non-empty string.
 * @param value Unknown evidence scalar.
 * @returns Whether the value is non-empty text.
 */
export function isObservationString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * Narrow one value to a non-negative safe integer.
 * @param value Unknown evidence scalar.
 * @returns Whether the value is a persistence-safe count.
 */
export function isObservationCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
}

/**
 * Narrow one value to a canonical non-negative decimal string.
 * @param value Unknown evidence scalar.
 * @returns Whether the value preserves an exact decimal.
 */
export function isObservationDecimal(
  value: unknown
): value is RunEvidenceDecimal {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
}

/**
 * Compare already snapshotted JSON-safe evidence structures.
 * @param left First safe evidence value.
 * @param right Second safe evidence value.
 * @returns Whether both values serialize identically.
 */
export function observationValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Validate an ordered inclusive decimal window.
 * @param started Inclusive lower decimal bound.
 * @param ended Inclusive upper decimal bound.
 * @returns Whether both bounds are canonical and ordered.
 */
export function isOrderedDecimalWindow(
  started: unknown,
  ended: unknown
): boolean {
  return (
    isObservationDecimal(started) &&
    isObservationDecimal(ended) &&
    BigInt(started) <= BigInt(ended)
  )
}
