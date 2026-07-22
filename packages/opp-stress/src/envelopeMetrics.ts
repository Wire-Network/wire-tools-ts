import {
  createEnvelopeBaseline,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import { projectOppEnvelopeSaturationMetrics } from "./envelopeMetricProjection.js"
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
  MalformedOppEnvelopeRecord,
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"
export { projectOppEnvelopeSaturationMetrics } from "./envelopeMetricProjection.js"
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
 * Collect confirmed OPP envelope saturation metrics from a debugging directory.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param window Direction, epoch, timestamp metadata, and saturation strategy.
 * @returns Validated metrics with exact candidate accounting and health issues.
 */
export async function collectOppEnvelopeSaturationMetrics(
  storageDir: string,
  window: OppEnvelopeSaturationWindow = {}
): Promise<OppEnvelopeSaturationMetrics> {
  const result = await readEnvelopeIntegrity(
    storageDir,
    createEnvelopeBaseline([])
  )
  return projectOppEnvelopeSaturationMetrics(result, window)
}
