import { createEnvelopeBaseline, readEnvelopeIntegrity, type EnvelopeBaseline, type EnvelopeIntegrityResult } from "../envelope-integrity/index.js"

import { projectSnapshotSaturationMetrics } from "./envelopeMetricProjection.js"
import type {
  EnvelopeMetricSnapshot,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"

/**
 * A pluggable origin of confirmed OPP envelope records for saturation metrics.
 *
 * Decouples metric collection from the local debug-artifact filesystem so the
 * same projection serves a co-located cluster (filesystem), an on-chain RPC
 * read, or a remote debugging-server. Each call returns one point-in-time
 * snapshot; the source owns how records are discovered and validated.
 */
export interface EnvelopeRecordSource {
  /** Read the current confirmed records plus candidate/issue accounting. */
  readonly snapshot: () => Promise<EnvelopeMetricSnapshot>
}

/**
 * Map a strict filesystem integrity result into a source-agnostic snapshot.
 *
 * `scan_failed` becomes `source_failed`; `valid` pairs become metric records
 * (a `ValidEnvelopePair` structurally satisfies the narrower record), and the
 * candidate count and issues carry through for telemetry health.
 *
 * @param result Strict reader result over the debug-artifact directory.
 * @returns The equivalent source-agnostic snapshot.
 */
export function envelopeIntegritySnapshot(
  result: EnvelopeIntegrityResult
): EnvelopeMetricSnapshot {
  return {
    kind: result.kind === "scan_failed" ? "source_failed" : "collected",
    records: result.valid,
    candidateCount: result.candidates.length,
    issues: result.issues
  }
}

/**
 * Build a source over the local OPP debug-artifact directory.
 *
 * Wraps the strict, integrity-validating `readEnvelopeIntegrity` reader as the
 * first `EnvelopeRecordSource`. Each snapshot re-reads and re-validates the
 * directory against `baseline`.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param baseline Pre-phase baseline of already-seen keys; defaults to empty.
 * @returns A filesystem-backed envelope record source.
 */
export function filesystemEnvelopeSource(
  storageDir: string,
  baseline: EnvelopeBaseline = createEnvelopeBaseline([])
): EnvelopeRecordSource {
  return {
    snapshot: async () =>
      envelopeIntegritySnapshot(
        await readEnvelopeIntegrity(storageDir, baseline)
      )
  }
}

/**
 * Project a strict filesystem integrity result into OPP saturation metrics.
 *
 * Filesystem back-compat adapter over the source-agnostic
 * `projectSnapshotSaturationMetrics`: existing callers that already hold an
 * `EnvelopeIntegrityResult` (e.g. the phase-metrics evidence path) keep this
 * signature while the saturation core stays source-agnostic.
 *
 * @param result Confirmed strict-reader result.
 * @param window Endpoint, epoch, and saturation filters.
 * @returns Deterministic metrics with coherent candidate health.
 */
export function projectOppEnvelopeSaturationMetrics(
  result: EnvelopeIntegrityResult,
  window: OppEnvelopeSaturationWindow = {}
): OppEnvelopeSaturationMetrics {
  return projectSnapshotSaturationMetrics(
    envelopeIntegritySnapshot(result),
    window
  )
}
