import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  type OppEnvelopeTelemetryHealth
} from "../envelopeMetricTypes.js"
import {
  OppEnvelopeTelemetryHealthParseError,
  parseOppEnvelopeTelemetryHealth
} from "../telemetryHealth.js"
import {
  RampBreakageCategories,
  RampBreakageCategory,
  RunEvidenceParseErrorCode,
  RunEvidenceParseResultKind,
  RunEvidenceSchemaVersion,
  type RunEvidenceRecordKind
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceParseResult
} from "./RunEvidenceCoreTypes.js"

/** Unknown JSON object narrowed for exact-key inspection. */
export type UnknownRecord = Readonly<Record<string, unknown>>

type TypeGuard<T> = (value: unknown) => value is T

/** Parse an unknown value through a schema guard without throwing. */
export function parseEvidence<T>(
  input: unknown,
  record: RunEvidenceRecordKind,
  guard: TypeGuard<T>
): RunEvidenceParseResult<T> {
  if (guard(input)) return { ok: true, value: input }
  return {
    ok: false,
    error: {
      kind: RunEvidenceParseResultKind.Failure,
      record,
      code: isUnsupportedSchema(input)
        ? RunEvidenceParseErrorCode.UnsupportedSchemaVersion
        : RunEvidenceParseErrorCode.InvalidShape
    }
  }
}

/** Narrow an unknown value to an object containing exactly the supplied keys. */
export function isExactRecord(
  value: unknown,
  keys: readonly string[]
): value is UnknownRecord {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  )
}

/** Narrow an unknown value to a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Narrow an unknown value to a positive safe integer. */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** Narrow an unknown value to a non-negative safe integer. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Validate an inclusive pair of canonical non-negative decimal strings. */
export function isOrderedDecimals(start: unknown, end: unknown): boolean {
  return isDecimal(start) && isDecimal(end) && BigInt(start) <= BigInt(end)
}

/** Narrow an unknown value to a full lowercase SHA-256 digest. */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

/** Validate a host-absolute path already in normalized resolved form. */
export function isAbsoluteNormalizedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Path.isAbsolute(value) &&
    Path.resolve(value) === value
  )
}

/** Narrow an unknown value through the stable Todo 4 telemetry parser. */
export function isTelemetryHealth(
  value: unknown
): value is OppEnvelopeTelemetryHealth {
  try {
    parseOppEnvelopeTelemetryHealth(value)
    return true
  } catch (error) {
    if (error instanceof OppEnvelopeTelemetryHealthParseError) return false
    throw error
  }
}

/** Validate that a breakage category matches its telemetry terminal state. */
export function hasBreakageTelemetry(
  category: RampBreakageCategory,
  telemetry: OppEnvelopeTelemetryHealth
): boolean {
  return category === RampBreakageCategory.TelemetryIntegrity
    ? telemetry.kind === OppEnvelopeTelemetryHealthKind.Degraded
    : telemetry.kind !== OppEnvelopeTelemetryHealthKind.Degraded
}

/** Narrow a value to a canonical breakage category. */
export function isBreakageCategory(
  value: unknown
): value is RampBreakageCategory {
  return (
    typeof value === "string" &&
    RampBreakageCategories.some(category => category === value)
  )
}

/** Report whether a string list contains no duplicates. */
export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/** Validate a sorted unique array of non-empty names. */
export function isSortedUniqueNames(
  value: unknown
): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(isNonEmptyString) ||
    !hasUniqueStrings(value)
  )
    return false
  return value.slice(1).every((name, index) => {
    const previous = value[index]
    return previous !== undefined && previous < name
  })
}

function isDecimal(value: unknown): value is RunEvidenceDecimal {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUnsupportedSchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.hasOwn(value, "schemaVersion") &&
    value.schemaVersion !== RunEvidenceSchemaVersion
  )
}
