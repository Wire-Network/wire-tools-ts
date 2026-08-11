import { OppEnvelopeTelemetryHealthParseError } from "./TelemetryHealthParseError.js"

/** Parse an exact-key object at an untrusted telemetry boundary. */
export function parseExactRecord(
  value: unknown,
  keys: readonly string[],
  path: string
): object {
  if (!isExactRecord(value, keys)) {
    throw invalid(
      path,
      `must be an object containing exactly ${keys.join(", ")}`
    )
  }
  return value
}

/** Check whether a value is a non-array object with exactly the requested keys. */
export function isExactRecord(
  value: unknown,
  keys: readonly string[]
): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  )
}

/** Read one own property from a previously narrowed telemetry object. */
export function field(record: object, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key))
    throw invalid(`${path}.${key}`, "is required")
  return Reflect.get(record, key)
}

/** Parse a JSON-safe non-negative integer count. */
export function parseCount(value: unknown, path: string): number {
  if (!isCount(value))
    throw invalid(path, "must be a non-negative safe integer")
  return value
}

/** Narrow a value to a JSON-safe non-negative integer count. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Parse a boolean telemetry contract field. */
export function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "must be a boolean")
  return value
}

/** Narrow a value to a nonempty string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Narrow a value to a readonly unknown array before item parsing. */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** Create a typed telemetry parse error for one contract path. */
export function invalid(
  path: string,
  problem: string
): OppEnvelopeTelemetryHealthParseError {
  return new OppEnvelopeTelemetryHealthParseError(path, problem)
}
