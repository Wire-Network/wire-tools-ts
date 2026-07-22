import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { OppEnvelopeTelemetryHealthKind } from "@wireio/test-opp-stress"
import type {
  HealthyOppEnvelopeTelemetryHealth,
  OppPhaseEnvelopeMetrics
} from "@wireio/test-opp-stress"

import type { BurstResult } from "./boundedBursts.js"
import type {
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPendingPhaseEnvelopeMetrics,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressPhaseResult,
  SwapStressUnmeasuredPhaseEnvelopeMetrics,
  SwapStressUnmeasuredReason
} from "./phaseRunnerMetricTypes.js"
import type {
  SwapStressPayoutObservation,
  SwapStressPhase
} from "./phaseRunnerTypes.js"
import type {
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressPendingPhaseObservation
} from "./phaseRunnerTelemetry.js"

/**
 * Classify generic OPP telemetry without fabricating terminal degradation.
 *
 * @param metrics Complete generic phase metrics from the canonical collector.
 * @returns Healthy metrics as measured, or retryable observations as pending.
 */
export function classifyOppPhaseMetrics(
  metrics: OppPhaseEnvelopeMetrics
): Exclude<
  SwapStressEnvelopeMetricCollectionResult,
  { readonly kind: "degraded" }
> {
  const health = metrics.health
  switch (health.kind) {
    case OppEnvelopeTelemetryHealthKind.Healthy:
      return {
        kind: "measured",
        metrics: projectOppPhaseMetrics({ ...metrics, health })
      }
    case OppEnvelopeTelemetryHealthKind.Empty:
    case OppEnvelopeTelemetryHealthKind.PendingPublication:
      return {
        kind: "pending",
        observation: { ...metrics, saturated: false, health }
      }
    default:
      return assertNeverHealth(health)
  }
}

/**
 * Project complete generic OPP phase telemetry into direct-flow metrics.
 * @param metrics Generic phase observation and evidence correlation.
 * @returns A measured direct-flow branch preserving exact provenance.
 */
export function projectOppPhaseMetrics(
  metrics: OppPhaseEnvelopeMetrics & {
    readonly health: HealthyOppEnvelopeTelemetryHealth
  }
): SwapStressMeasuredPhaseEnvelopeMetrics & {
  readonly health: HealthyOppEnvelopeTelemetryHealth
} {
  const summary = {
      phase: metrics.phase,
      saturated: metrics.saturated,
      envelopeCount: metrics.envelopeCount,
      envelopeByteSizes: metrics.envelopeByteSizes,
      endpoint: metrics.endpoint,
      epochStart: metrics.window.epochStart,
      epochEnd: metrics.window.epochEnd,
      measurement: "measured" as const,
      health: metrics.health,
      malformedRecords: metrics.malformedRecords
    },
    provenanceFields = {
      kind: "opp_phase" as const,
      strategy: metrics.strategy,
      window: metrics.window,
      solanaOversized: metrics.solanaOversized,
      epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
      selectedArtifacts: metrics.selectedArtifacts
    }
  switch (metrics.evidence.kind) {
    case "not_recorded":
      return {
        ...summary,
        provenance: { ...provenanceFields, evidence: metrics.evidence },
        artifactRefs: []
      }
    case "recorded":
      return {
        ...summary,
        provenance: { ...provenanceFields, evidence: metrics.evidence },
        artifactRefs: metrics.evidence.artifactRefs
      }
    default:
      return assertNever(metrics.evidence)
  }
}

/**
 * Project retryable generic OPP telemetry into an honest pending flow branch.
 * @param metrics Exact unsaturated canonical observation.
 * @returns Pending direct-flow metrics preserving complete provenance.
 */
export function projectPendingOppPhaseMetrics(
  metrics: SwapStressPendingPhaseObservation
): SwapStressPendingPhaseEnvelopeMetrics {
  const summary = {
      phase: metrics.phase,
      saturated: false as const,
      envelopeCount: metrics.envelopeCount,
      envelopeByteSizes: metrics.envelopeByteSizes,
      endpoint: metrics.endpoint,
      epochStart: metrics.window.epochStart,
      epochEnd: metrics.window.epochEnd,
      measurement: "pending" as const,
      health: metrics.health,
      malformedRecords: metrics.malformedRecords
    },
    provenanceFields = {
      kind: "opp_phase" as const,
      strategy: metrics.strategy,
      window: metrics.window,
      solanaOversized: metrics.solanaOversized,
      epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
      selectedArtifacts: metrics.selectedArtifacts
    }
  switch (metrics.evidence.kind) {
    case "not_recorded":
      return {
        ...summary,
        provenance: { ...provenanceFields, evidence: metrics.evidence },
        artifactRefs: []
      }
    case "recorded":
      return {
        ...summary,
        provenance: { ...provenanceFields, evidence: metrics.evidence },
        artifactRefs: metrics.evidence.artifactRefs
      }
    default:
      return assertNever(metrics.evidence)
  }
}

/**
 * Merge one complete metrics branch with phase execution telemetry.
 * @param phase Executed phase label.
 * @param burst Bounded transaction results.
 * @param payout Observed payout or null.
 * @param metrics Complete measured or unmeasured metrics branch.
 * @param observationStartedAtMs Phase observation start timestamp.
 * @param observationEndedAtMs Phase observation end timestamp.
 * @returns A phase result preserving the complete metrics branch.
 */
export function phaseResult(
  phase: SwapStressPhase,
  burst: BurstResult,
  payout: SwapStressPayoutObservation | null,
  metrics: SwapStressPhaseEnvelopeMetrics,
  observationStartedAtMs: number,
  observationEndedAtMs: number
): SwapStressPhaseResult {
  return {
    ...metrics,
    phase,
    observationStartedAtMs,
    observationEndedAtMs,
    txSuccesses: burst.successes.length,
    txFailures: burst.failures.length,
    payout
  }
}

/**
 * Build explicit unmeasured metrics for a phase without an observation.
 * @param phase Phase or classifier label.
 * @param endpointsType Expected endpoint direction.
 * @param unmeasuredReason Exact reason collection produced no observation.
 * @returns Literal zero metrics with null health and provenance.
 */
export function emptyMetrics(
  phase: string,
  endpointsType: DebugOutpostEndpointsType,
  unmeasuredReason: SwapStressUnmeasuredReason
): SwapStressUnmeasuredPhaseEnvelopeMetrics {
  return {
    measurement: "unmeasured",
    unmeasuredReason,
    phase,
    saturated: false,
    envelopeCount: 0,
    envelopeByteSizes: [],
    endpoint: DebugOutpostEndpointsType[endpointsType],
    epochStart: "0",
    epochEnd: "0",
    health: null,
    malformedRecords: [],
    artifactRefs: [],
    provenance: null
  }
}

/**
 * Build the zero-value result for a phase that was not run.
 * @param phase Phase or classifier label.
 * @returns An unmeasured phase result marked `phase_not_run`.
 */
export function emptyPhaseResult(phase: string): SwapStressPhaseResult {
  return {
    ...emptyMetrics(phase, DebugOutpostEndpointsType.UNKNOWN, "phase_not_run"),
    txSuccesses: 0,
    txFailures: 0,
    observationStartedAtMs: 0,
    observationEndedAtMs: 0,
    payout: null
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected OPP phase evidence: ${String(value)}`)
}

function assertNeverHealth(value: never): never {
  throw new TypeError(`Unexpected OPP phase telemetry health: ${String(value)}`)
}
