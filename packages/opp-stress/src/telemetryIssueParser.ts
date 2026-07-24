import { isTelemetryIssueContext } from "./telemetryIssueContextParser.js"
import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "./TelemetryIssueTypes.js"
import {
  field,
  invalid,
  isExactRecord,
  isUnknownArray
} from "./telemetryParseSupport.js"

const StorageScopeBaseKey = "$storage",
  IssueKeys = ["code", "baseKey", "context"] as const,
  GlobalIssueByCode = {
    [OppEnvelopeTelemetryIssueCode.InvalidStorageKey]: false,
    [OppEnvelopeTelemetryIssueCode.UnknownEndpoint]: false,
    [OppEnvelopeTelemetryIssueCode.MissingDataSidecar]: false,
    [OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar]: false,
    [OppEnvelopeTelemetryIssueCode.DataSidecarSymlink]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink]: false,
    [OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular]: false,
    [OppEnvelopeTelemetryIssueCode.DataReadFailed]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataReadFailed]: false,
    [OppEnvelopeTelemetryIssueCode.DataSidecarChanged]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged]: false,
    [OppEnvelopeTelemetryIssueCode.DataDecodeFailed]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed]: false,
    [OppEnvelopeTelemetryIssueCode.DataHashMismatch]: false,
    [OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch]: false,
    [OppEnvelopeTelemetryIssueCode.EpochMismatch]: false,
    [OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot]: false,
    [OppEnvelopeTelemetryIssueCode.StorageRootSymlink]: true,
    [OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink]: true,
    [OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory]: true,
    [OppEnvelopeTelemetryIssueCode.StorageRootChanged]: true,
    [OppEnvelopeTelemetryIssueCode.StorageRootReadFailed]: true,
    [OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed]: true,
    [OppEnvelopeTelemetryIssueCode.DirectoryScanFailed]: true
  } satisfies Record<OppEnvelopeTelemetryIssueCode, boolean>

/** Parse and narrow every issue in an unknown telemetry issue array. */
export function parseTelemetryIssues(
  value: unknown
): readonly OppEnvelopeTelemetryIssue[] {
  if (!isUnknownArray(value)) throw invalid("health.issues", "must be an array")
  return value.map((issue, index) =>
    parseTelemetryIssue(issue, `health.issues[${index}]`)
  )
}

/** Require a nonempty issue tuple for pending or degraded health. */
export function requireTelemetryIssues(
  issues: readonly OppEnvelopeTelemetryIssue[]
): readonly [OppEnvelopeTelemetryIssue, ...OppEnvelopeTelemetryIssue[]] {
  const [firstIssue, ...remainingIssues] = issues
  if (firstIssue === undefined)
    throw invalid("health.issues", "requires at least one issue")
  return [firstIssue, ...remainingIssues]
}

/** Return whether an issue describes global storage state. */
export function isGlobalTelemetryIssue(
  issue: OppEnvelopeTelemetryIssue
): boolean {
  return GlobalIssueByCode[issue.code]
}

/** Return whether an issue belongs to one discovered candidate. */
export function isCandidateTelemetryIssue(
  issue: OppEnvelopeTelemetryIssue
): boolean {
  return !isGlobalTelemetryIssue(issue)
}

function parseTelemetryIssue(
  value: unknown,
  path: string
): OppEnvelopeTelemetryIssue {
  if (!isTelemetryIssue(value))
    throw invalid(path, "must match a telemetry issue variant")
  return value
}

function isTelemetryIssue(value: unknown): value is OppEnvelopeTelemetryIssue {
  if (!isExactRecord(value, IssueKeys)) return false
  const code = field(value, "code", "issue"),
    baseKey = field(value, "baseKey", "issue"),
    context = field(value, "context", "issue")
  if (!isIssueCode(code) || typeof baseKey !== "string") return false
  if (GlobalIssueByCode[code] && baseKey !== StorageScopeBaseKey) return false
  return isTelemetryIssueContext(code, context)
}

function isIssueCode(value: unknown): value is OppEnvelopeTelemetryIssueCode {
  return typeof value === "string" && Object.hasOwn(GlobalIssueByCode, value)
}
