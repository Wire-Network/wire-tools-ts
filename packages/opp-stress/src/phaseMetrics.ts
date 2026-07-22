import {
  oppDebuggingPath,
  readEnvelopeIntegrity,
  type ValidEnvelopePair
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { projectOppEnvelopeSaturationMetrics } from "./envelopeMetricProjection.js"
import type { OppEnvelopeSaturationStrategy } from "./envelopeMetrics.js"
import type {
  OppPhaseCapturedArtifact,
  OppPhaseEnvelopeMetrics,
  OppPhaseMetricRequest,
  OppPhaseSelectedArtifact
} from "./phaseMetricTypes.js"
import { parseOppPhaseWindow } from "./phaseMetricWindow.js"
import type { RunEvidencePersistence } from "./runEvidencePersistence.js"
import {
  RunEvidenceEndpoint,
  RunEvidenceEndpoints,
  RunEvidenceSaturationStrategy
} from "./runEvidenceTypes.js"

export type {
  OppPhaseBaselineReference,
  OppPhaseCapturedArtifact,
  OppPhaseEnvelopeMetrics,
  OppPhaseEvidenceSink,
  OppPhaseMetricBaseline,
  OppPhaseMetricEvidence,
  OppPhaseMetricRequest,
  OppPhaseSelectedArtifact
} from "./phaseMetricTypes.js"

/**
 * Project a cluster's strict OPP artifacts into complete phase verification inputs.
 *
 * @param clusterPath Canonical cluster root containing OPP debugging artifacts.
 * @param request Phase window, endpoint, pre-phase baseline, and evidence sink.
 * @returns Metrics, source diagnostics, and discriminated evidence correlation.
 */
export async function collectOppPhaseMetrics(
  clusterPath: string,
  request: OppPhaseMetricRequest
): Promise<OppPhaseEnvelopeMetrics> {
  const window = parseOppPhaseWindow(request),
    endpoint = canonicalEndpoint(request.endpointsType),
    strategy = canonicalStrategy(request.saturationStrategy ?? "rollover"),
    observation =
      request.evidenceSink === null
        ? null
        : request.evidenceSink.beginObservation(request.endedAtMs),
    integrity = await readEnvelopeIntegrity(
      oppDebuggingPath(clusterPath),
      request.baseline
    ),
    metrics = projectOppEnvelopeSaturationMetrics(integrity, {
      endpointsType: request.endpointsType,
      epochStart: request.epochStart,
      epochEnd: request.epochEnd,
      ...(request.saturationStrategy === undefined
        ? {}
        : { saturationStrategy: request.saturationStrategy })
    }),
    selectedKeys = new Set(metrics.envelopes.map(envelope => envelope.key)),
    selectedPairs = integrity.valid
      .filter(pair => selectedKeys.has(pair.baseKey))
      .sort(compareSelectedPairs),
    selectedArtifacts = selectedPairs.map(selectedArtifact),
    artifacts =
      observation === null
        ? []
        : await captureSelectedArtifacts(selectedPairs, observation),
    evidence =
      observation === null
        ? {
            kind: "not_recorded" as const,
            baseline: {
              identity: request.baseline.identity,
              artifactRefs: request.baseline.artifactRefs
            }
          }
        : {
            kind: "recorded" as const,
            baseline: {
              identity: request.baseline.identity,
              baseKeys: request.baseline.baseKeys,
              observationOrdinal: observation.ordinal,
              artifactRefs: request.baseline.artifactRefs
            },
            artifacts,
            artifactRefs: artifacts.flatMap(artifact => [
              artifact.immutableRefs.data.path,
              artifact.immutableRefs.metadata.path
            ])
          }
  return {
    phase: request.phase,
    endpoint,
    strategy,
    window,
    saturated: metrics.saturated,
    solanaOversized: metrics.solanaOversized,
    envelopeCount: metrics.envelopeCount,
    envelopeByteSizes: metrics.byteSizes,
    epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
    health: metrics.health,
    malformedRecords: metrics.malformedRecords,
    selectedArtifacts,
    evidence
  }
}

async function captureSelectedArtifacts(
  pairs: readonly ValidEnvelopePair[],
  observation: RunEvidencePersistence.Observation
): Promise<readonly OppPhaseCapturedArtifact[]> {
  return pairs.reduce<Promise<readonly OppPhaseCapturedArtifact[]>>(
    async (pending, pair) => {
      const captured = await pending,
        immutableRefs = await observation.captureArtifact({
          baseKey: pair.baseKey,
          dataBytes: Buffer.from(pair.dataBytes),
          metadataBytes: Buffer.from(pair.metadataBytes)
        })
      if (immutableRefs.data.sha256 !== pair.dataSha256)
        throw new PhaseArtifactHashMismatchError(
          pair.baseKey,
          pair.dataSha256,
          immutableRefs.data.sha256
        )
      return [...captured, { baseKey: pair.baseKey, immutableRefs }]
    },
    Promise.resolve([])
  )
}

function selectedArtifact(pair: ValidEnvelopePair): OppPhaseSelectedArtifact {
  return {
    baseKey: pair.baseKey,
    epoch: pair.epochIndex,
    index: pair.epochEnvelopeIndex,
    dataSha256: pair.dataSha256,
    dataMtimeNs: pair.dataMtimeNs,
    metadataMtimeNs: pair.metadataMtimeNs
  }
}

function compareSelectedPairs(
  left: ValidEnvelopePair,
  right: ValidEnvelopePair
): number {
  return (
    left.epochIndex - right.epochIndex ||
    left.epochEnvelopeIndex - right.epochEnvelopeIndex ||
    (left.baseKey < right.baseKey ? -1 : left.baseKey > right.baseKey ? 1 : 0)
  )
}

function canonicalEndpoint(
  endpointsType: DebugOutpostEndpointsType
): RunEvidenceEndpoint {
  const name = DebugOutpostEndpointsType[endpointsType]
  if (isRunEvidenceEndpoint(name)) return name
  throw new TypeError(`Unsupported OPP phase endpoint: ${name}`)
}

function isRunEvidenceEndpoint(value: string): value is RunEvidenceEndpoint {
  return RunEvidenceEndpoints.some(endpoint => endpoint === value)
}

function canonicalStrategy(
  strategy: OppEnvelopeSaturationStrategy
): RunEvidenceSaturationStrategy {
  switch (strategy) {
    case "rollover":
      return RunEvidenceSaturationStrategy.Rollover
    case "byte_threshold":
      return RunEvidenceSaturationStrategy.ByteThreshold
    default:
      return assertNever(strategy)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected OPP phase strategy: ${String(value)}`)
}

class PhaseArtifactHashMismatchError extends Error {
  readonly name = "PhaseArtifactHashMismatchError"

  constructor(
    readonly baseKey: string,
    readonly expectedSha256: string,
    readonly actualSha256: string
  ) {
    super(`immutable data digest differs from strict pair: ${baseKey}`)
  }
}
