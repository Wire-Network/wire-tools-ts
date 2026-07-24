import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import {
  RunEvidenceClusterConfigState,
  RunEvidenceConfigUnavailableReason,
  RunEvidenceEndpoints,
  RunEvidenceLifecycles,
  RunEvidencePath,
  RunEvidenceSetupRefState,
  type RunEvidenceEndpoint,
  type RunEvidenceLifecycle
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceIterationRecordRef,
  RunEvidenceRampConfig,
  RunEvidencePendingSetupRef,
  RunEvidenceRecordRefs,
  RunEvidenceRuntime,
  RunEvidenceSetupRecordRef,
  RunEvidenceTerminalRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceEndpointResult } from "./RunEvidenceRecordTypes.js"
import {
  hasUniqueStrings,
  isExactRecord,
  isNonEmptyString,
  isPositiveSafeInteger,
  isSha256,
  isTelemetryHealth
} from "./runEvidencePrimitiveGuards.js"

/** Narrow a value to a non-empty unique canonical endpoint set. */
export function isEndpointSet(
  value: unknown
): value is readonly RunEvidenceEndpoint[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isEndpoint) &&
    hasUniqueStrings(value)
  )
}

/** Narrow a value to a unique, possibly empty canonical endpoint set. */
export function isOptionalEndpointSet(
  value: unknown
): value is readonly RunEvidenceEndpoint[] {
  return (
    Array.isArray(value) && value.every(isEndpoint) && hasUniqueStrings(value)
  )
}

/** Validate required, saturated, missing, and per-endpoint decisions together. */
export function hasConsistentEndpointDecision(decision: {
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly endpointResults: readonly RunEvidenceEndpointResult[]
}): boolean {
  const {
    requiredEndpoints,
    saturatedEndpoints,
    missingEndpoints,
    endpointResults
  } = decision
  return (
    hasConsistentEndpointSets(
      requiredEndpoints,
      saturatedEndpoints,
      missingEndpoints
    ) &&
    endpointResults.length === requiredEndpoints.length &&
    requiredEndpoints.every(endpoint => {
      const result = endpointResults.find(item => item.endpoint === endpoint)
      return (
        result !== undefined &&
        result.saturated === saturatedEndpoints.includes(endpoint) &&
        (!result.saturated ||
          result.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy)
      )
    })
  )
}

/** Validate that every endpoint result carries healthy telemetry. */
export function hasHealthyEndpointResults(
  results: readonly RunEvidenceEndpointResult[]
): boolean {
  return results.every(
    result => result.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy
  )
}

/** Validate saturated and missing sets as an exact required-set partition. */
export function hasConsistentEndpointSets(
  required: readonly RunEvidenceEndpoint[],
  saturated: readonly RunEvidenceEndpoint[],
  missing: readonly RunEvidenceEndpoint[]
): boolean {
  return (
    saturated.every(endpoint => required.includes(endpoint)) &&
    missing.length === required.length - saturated.length &&
    required.every(
      endpoint => saturated.includes(endpoint) !== missing.includes(endpoint)
    )
  )
}

/** Narrow an unknown value to a unique endpoint-result array. */
export function isEndpointResults(
  value: unknown
): value is readonly RunEvidenceEndpointResult[] {
  return (
    Array.isArray(value) &&
    value.every(isEndpointResult) &&
    hasUniqueStrings(value.map(result => result.endpoint))
  )
}

/** Validate pending or digest-bearing lifecycle refs without optional ambiguity. */
export function isRecordRefs(value: unknown): value is RunEvidenceRecordRefs {
  if (!isExactRecord(value, ["setup", "iterations", "terminal"])) return false
  if (isPendingSetupRef(value.setup))
    return (
      Array.isArray(value.iterations) &&
      value.iterations.length === 0 &&
      value.terminal === null
    )
  return (
    isSetupRecordRef(value.setup) &&
    isContiguousIterationRefs(value.iterations) &&
    (value.terminal === null || isTerminalRecordRef(value.terminal))
  )
}

/** Validate contiguous zero-based digest-bearing iteration refs. */
export function isContiguousIterationRefs(
  value: unknown
): value is readonly RunEvidenceIterationRecordRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (ref, index) =>
        isExactRecord(ref, ["path", "sha256"]) &&
        ref.path ===
          `${RunEvidencePath.Iterations}/${String(index).padStart(6, "0")}.json` &&
        isSha256(ref.sha256)
    )
  )
}

/** Narrow a value to an immutable setup record ref. */
export function isSetupRecordRef(
  value: unknown
): value is RunEvidenceSetupRecordRef {
  return (
    isExactRecord(value, ["path", "sha256"]) &&
    value.path === RunEvidencePath.Setup &&
    isSha256(value.sha256)
  )
}

/** Narrow a value to an immutable terminal record ref. */
export function isTerminalRecordRef(
  value: unknown
): value is RunEvidenceTerminalRecordRef {
  return (
    isExactRecord(value, ["path", "sha256"]) &&
    value.path === RunEvidencePath.Terminal &&
    isSha256(value.sha256)
  )
}

/** Validate persisted ramp configuration invariants. */
export function isRampConfig(value: unknown): value is RunEvidenceRampConfig {
  return (
    isExactRecord(value, [
      "initialCount",
      "multiplier",
      "maxCount",
      "phaseTimeoutMs"
    ]) &&
    isPositiveSafeInteger(value.initialCount) &&
    isPositiveSafeInteger(value.multiplier) &&
    value.multiplier > 1 &&
    isPositiveSafeInteger(value.maxCount) &&
    value.initialCount <= value.maxCount &&
    isPositiveSafeInteger(value.phaseTimeoutMs)
  )
}

/** Validate persisted Node runtime identity. */
export function isRuntime(value: unknown): value is RunEvidenceRuntime {
  return (
    isExactRecord(value, ["nodeVersion", "platform", "architecture"]) &&
    isNonEmptyString(value.nodeVersion) &&
    isNonEmptyString(value.platform) &&
    isNonEmptyString(value.architecture)
  )
}

/** Validate the lifecycle-discriminated cluster-config snapshot shape. */
export function isClusterConfigSnapshot(
  value: unknown
): value is RunEvidenceClusterConfigSnapshot {
  if (isExactRecord(value, ["kind"]))
    return value.kind === RunEvidenceClusterConfigState.Pending
  if (isExactRecord(value, ["kind", "path", "sha256"]))
    return (
      value.kind === RunEvidenceClusterConfigState.Captured &&
      value.path === RunEvidencePath.ClusterConfigSnapshot &&
      isSha256(value.sha256)
    )
  return (
    isExactRecord(value, ["kind", "reason"]) &&
    value.kind === RunEvidenceClusterConfigState.Unavailable &&
    value.reason === RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
  )
}

/** Narrow a value to a controller lifecycle label. */
export function isLifecycle(value: unknown): value is RunEvidenceLifecycle {
  return (
    typeof value === "string" &&
    RunEvidenceLifecycles.some(lifecycle => lifecycle === value)
  )
}

/** Narrow a value to the explicit pre-setup pending ref. */
export function isPendingSetupRef(
  value: unknown
): value is RunEvidencePendingSetupRef {
  return (
    isExactRecord(value, ["kind"]) &&
    value.kind === RunEvidenceSetupRefState.Pending
  )
}

function isEndpointResult(value: unknown): value is RunEvidenceEndpointResult {
  return (
    isExactRecord(value, ["endpoint", "telemetry", "saturated"]) &&
    isEndpoint(value.endpoint) &&
    isTelemetryHealth(value.telemetry) &&
    typeof value.saturated === "boolean"
  )
}

function isEndpoint(value: unknown): value is RunEvidenceEndpoint {
  return (
    typeof value === "string" &&
    RunEvidenceEndpoints.some(endpoint => endpoint === value)
  )
}
