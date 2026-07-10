import { oppDebuggingPath } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  collectOppEnvelopeSaturationMetrics,
  type OppEnvelopeSaturationStrategy
} from "./envelopeMetrics.js"

/** Envelope collector request for a named OPP workload phase. */
export type OppPhaseMetricRequest = {
  /** Phase whose window is being measured. */
  readonly phase: string
  /** Inclusive phase start timestamp. */
  readonly startedAtMs: number
  /** Inclusive phase end timestamp. */
  readonly endedAtMs: number
  /** Endpoint direction expected to carry the phase's OPP evidence. */
  readonly endpointsType: DebugOutpostEndpointsType
  /** Saturation classifier; defaults to rollover for generic OPP stress. */
  readonly saturationStrategy?: OppEnvelopeSaturationStrategy
}

/** Phase envelope metrics projected into ramp telemetry. */
export type OppPhaseEnvelopeMetrics = {
  /** Phase label these metrics describe. */
  readonly phase: string
  /** Whether this phase satisfies the selected saturation strategy. */
  readonly saturated: boolean
  /** Whether any matching Solana destination envelope exceeds the raw transaction byte cap. */
  readonly solanaOversized: boolean
  /** Matching envelope count. */
  readonly envelopeCount: number
  /** Matching envelope byte sizes. */
  readonly envelopeByteSizes: readonly number[]
  /** Endpoint direction label persisted for evidence. */
  readonly endpoint: string
  /** Inclusive epoch lower bound. */
  readonly epochStart: number
  /** Inclusive epoch upper bound. */
  readonly epochEnd: number
}

/**
 * Project a cluster's OPP debug artifacts into ramp-ready phase metrics.
 *
 * @param clusterPath Cluster root containing `data/opp-debugging` artifacts.
 * @param request Phase label, endpoint direction, and timestamp window.
 * @returns Phase metrics suitable for OPP stress ramp evidence.
 */
export async function collectOppPhaseMetrics(
  clusterPath: string,
  request: OppPhaseMetricRequest
): Promise<OppPhaseEnvelopeMetrics> {
  const window = {
    endpointsType: request.endpointsType,
    timestampStartMs: request.startedAtMs,
    timestampEndMs: request.endedAtMs,
    ...(request.saturationStrategy === undefined
      ? {}
      : { saturationStrategy: request.saturationStrategy })
  }
  const metrics = await collectOppEnvelopeSaturationMetrics(
    oppDebuggingPath(clusterPath),
    window
  )
  return {
    phase: request.phase,
    saturated: metrics.saturated,
    solanaOversized: metrics.solanaOversized,
    envelopeCount: metrics.envelopeCount,
    envelopeByteSizes: metrics.byteSizes,
    endpoint: DebugOutpostEndpointsType[request.endpointsType],
    epochStart: metrics.envelopes[0]?.epoch ?? 0,
    epochEnd: metrics.envelopes[metrics.envelopes.length - 1]?.epoch ?? 0
  }
}
