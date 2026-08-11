import { projectSnapshotSaturationMetrics } from "./envelopeMetricProjection.js"
import {
  filesystemEnvelopeSource,
  type EnvelopeRecordSource
} from "./envelopeRecordSource.js"
import type {
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"

export {
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "./envelopeMetricTypes.js"
export type {
  EnvelopeMetricRecord,
  EnvelopeMetricSnapshot,
  MalformedOppEnvelopeRecord,
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"
export { projectSnapshotSaturationMetrics } from "./envelopeMetricProjection.js"
export {
  envelopeIntegritySnapshot,
  filesystemEnvelopeSource,
  projectOppEnvelopeSaturationMetrics
} from "./envelopeRecordSource.js"
export type { EnvelopeRecordSource } from "./envelopeRecordSource.js"
export { mapEnvelopeIntegrityIssue } from "./envelopeTelemetryIssueMapper.js"
export type {
  DegradedOppEnvelopeTelemetryHealth,
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryCounts,
  OppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryObservation,
  PendingOppEnvelopeTelemetryHealth
} from "./TelemetryHealthTypes.js"
export { OppEnvelopeTelemetryHealthKind } from "./TelemetryHealthTypes.js"
export type {
  OppEnvelopeTelemetryFileError,
  OppEnvelopeTelemetryFileIdentity,
  OppEnvelopeTelemetryFileOperation,
  OppEnvelopeTelemetryIssue
} from "./TelemetryIssueTypes.js"
export { OppEnvelopeTelemetryIssueCode } from "./TelemetryIssueTypes.js"
export { parseOppEnvelopeTelemetryHealth } from "./telemetryHealth.js"
export { OppEnvelopeTelemetryHealthParseError } from "./TelemetryHealthParseError.js"

/**
 * Collect confirmed OPP envelope saturation metrics from a record source.
 *
 * @param source Pluggable envelope record source (on-chain, debugging-server, …).
 * @param window Direction, epoch, timestamp metadata, and saturation strategy.
 * @returns Validated metrics with exact candidate accounting and health issues.
 */
export async function collectOppEnvelopeSaturationMetrics(
  source: EnvelopeRecordSource,
  window?: OppEnvelopeSaturationWindow
): Promise<OppEnvelopeSaturationMetrics>
/**
 * Collect confirmed OPP envelope saturation metrics from a debugging directory.
 *
 * Convenience over the local `filesystemEnvelopeSource` — the original
 * co-located-cluster path.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param window Direction, epoch, timestamp metadata, and saturation strategy.
 * @returns Validated metrics with exact candidate accounting and health issues.
 */
export async function collectOppEnvelopeSaturationMetrics(
  storageDir: string,
  window?: OppEnvelopeSaturationWindow
): Promise<OppEnvelopeSaturationMetrics>
export async function collectOppEnvelopeSaturationMetrics(
  origin: EnvelopeRecordSource | string,
  window: OppEnvelopeSaturationWindow = {}
): Promise<OppEnvelopeSaturationMetrics> {
  const source =
    typeof origin === "string" ? filesystemEnvelopeSource(origin) : origin
  return projectSnapshotSaturationMetrics(await source.snapshot(), window)
}
