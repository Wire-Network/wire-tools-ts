import {
  RunEvidenceEndpoint,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategy,
  type RunEvidencePhase
} from "../runEvidenceTypes.js"
import {
  RunEvidenceVerificationIssueCode,
  type RunEvidenceRecomputedPhase
} from "../runEvidenceVerifierTypes.js"
import {
  type VerifiedEvidenceArtifact,
  type VerifiedEvidenceArtifacts
} from "./evidenceArtifacts.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

const SaturatedEnvelopeMinBytes = 62_259,
  SolanaRawTransactionBytesMax = 1_232

/** Recompute one phase exclusively from its declared immutable artifact pairs. */
export function recomputeEvidencePhase(
  phase: RunEvidencePhase,
  artifacts: VerifiedEvidenceArtifacts,
  recordPath: string,
  context: RunEvidenceVerificationContext
): RunEvidenceRecomputedPhase {
  const baselineArtifacts = resolvePairs(
      phase.baseline.artifactRefs,
      artifacts,
      `${recordPath}#${phase.label}:baseline`,
      context
    ),
    selected = resolvePairs(
      phase.artifactRefs,
      artifacts,
      `${recordPath}#${phase.label}:artifacts`,
      context
    ),
    baselineKeys = new Set([
      ...phase.baseline.baseKeys,
      ...baselineArtifacts.map(artifact => artifact.baseKey)
    ])
  selected.forEach(artifact => {
    if (baselineKeys.has(artifact.baseKey))
      context.issue(
        RunEvidenceVerificationIssueCode.ArtifactRefOverlap,
        recordPath,
        `phase ${phase.label} selected baseline artifact ${artifact.baseKey}`
      )
  })
  const epochStart = Number(phase.window.epochStart),
    epochEnd = Number(phase.window.epochEnd),
    matching = selected
      .filter(artifact => {
        const matches =
          artifact.endpoint === phase.endpoint &&
          artifact.epoch >= epochStart &&
          artifact.epoch <= epochEnd
        if (!matches)
          context.issue(
            RunEvidenceVerificationIssueCode.MetricMismatch,
            recordPath,
            `phase ${phase.label} selected out-of-filter artifact ${artifact.baseKey}`
          )
        return matches
      })
      .sort(compareArtifacts),
    byteSizes = matching.map(artifact => artifact.byteSize),
    indexes = matching.map(artifact => artifact.epochEnvelopeIndex),
    saturated =
      phase.status === RunEvidencePhaseStatus.Completed &&
      saturationFor(phase.strategy, matching),
    solanaOversized = matching.some(
      artifact =>
        artifact.endpoint === RunEvidenceEndpoint.DepotOutpostSolana &&
        artifact.byteSize > SolanaRawTransactionBytesMax
    ),
    recomputed: RunEvidenceRecomputedPhase = {
      label: phase.label,
      endpoint: phase.endpoint,
      envelopeCount: matching.length,
      envelopeByteSizes: byteSizes,
      epochEnvelopeIndexes: indexes,
      solanaOversized,
      saturated
    }
  comparePhaseMetrics(phase, recomputed, recordPath, context)
  comparePhaseTelemetry(phase, matching, recordPath, context)
  return recomputed
}

function resolvePairs(
  refs: readonly string[],
  artifacts: VerifiedEvidenceArtifacts,
  location: string,
  context: RunEvidenceVerificationContext
): readonly VerifiedEvidenceArtifact[] {
  const referenced = refs.flatMap(ref => {
      const artifact = artifacts.byRef.get(ref)
      if (artifact === undefined) {
        context.issue(
          RunEvidenceVerificationIssueCode.UndeclaredArtifactRef,
          location,
          `artifact ref is undeclared or invalid: ${ref}`
        )
        return []
      }
      return [artifact]
    }),
    keys = [...new Set(referenced.map(artifact => artifact.baseKey))]
  return keys.flatMap(baseKey => {
    const artifact = artifacts.byBaseKey.get(baseKey)
    if (artifact === undefined) return []
    if (
      !refs.includes(artifact.dataRef) ||
      !refs.includes(artifact.metadataRef)
    ) {
      context.issue(
        RunEvidenceVerificationIssueCode.IncompleteArtifactPair,
        location,
        `artifact ${baseKey} does not include both data and metadata refs`
      )
      return []
    }
    return [artifact]
  })
}

function comparePhaseMetrics(
  phase: RunEvidencePhase,
  recomputed: RunEvidenceRecomputedPhase,
  recordPath: string,
  context: RunEvidenceVerificationContext
): void {
  const recorded = phase.metrics,
    exact =
      recorded.envelopeCount === recomputed.envelopeCount &&
      sameNumbers(recorded.envelopeByteSizes, recomputed.envelopeByteSizes) &&
      sameNumbers(
        recorded.epochEnvelopeIndexes,
        recomputed.epochEnvelopeIndexes
      ) &&
      recorded.solanaOversized === recomputed.solanaOversized &&
      recorded.saturated === recomputed.saturated
  if (!exact)
    context.issue(
      RunEvidenceVerificationIssueCode.MetricMismatch,
      recordPath,
      `phase ${phase.label} recorded metrics differ from declared artifact bytes`
    )
}

function comparePhaseTelemetry(
  phase: RunEvidencePhase,
  selected: readonly VerifiedEvidenceArtifact[],
  recordPath: string,
  context: RunEvidenceVerificationContext
): void {
  const actual = phase.telemetry,
    candidateIssueBaseKeys = actual.issues
      .map(issue => issue.baseKey)
      .filter(baseKey => baseKey !== "$storage"),
    candidateIssueKeys = new Set(candidateIssueBaseKeys),
    selectedKeys = new Set(selected.map(artifact => artifact.baseKey)),
    candidateCount =
      actual.validCount + actual.filteredCount + candidateIssueKeys.size
  if (
    actual.validCount !== selected.length ||
    actual.issueCount !== actual.issues.length ||
    actual.candidateCount !== candidateCount ||
    candidateIssueBaseKeys.length !== candidateIssueKeys.size ||
    candidateIssueBaseKeys.some(baseKey => selectedKeys.has(baseKey))
  )
    context.issue(
      RunEvidenceVerificationIssueCode.TelemetryMismatch,
      recordPath,
      `phase ${phase.label} telemetry accounting differs from selected immutable artifacts`
    )
}

function saturationFor(
  strategy: RunEvidenceSaturationStrategy,
  artifacts: readonly VerifiedEvidenceArtifact[]
): boolean {
  switch (strategy) {
    case RunEvidenceSaturationStrategy.Rollover:
      return artifacts.some(artifact => artifact.epochEnvelopeIndex > 0)
    case RunEvidenceSaturationStrategy.ByteThreshold:
      return artifacts.some(
        artifact => artifact.byteSize >= SaturatedEnvelopeMinBytes
      )
    default:
      return assertNever(strategy)
  }
}

function compareArtifacts(
  left: VerifiedEvidenceArtifact,
  right: VerifiedEvidenceArtifact
): number {
  return (
    left.epoch - right.epoch ||
    left.epochEnvelopeIndex - right.epochEnvelopeIndex ||
    (left.baseKey < right.baseKey ? -1 : left.baseKey > right.baseKey ? 1 : 0)
  )
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function assertNever(value: never): never {
  throw new Error(`Unexpected evidence saturation strategy: ${String(value)}`)
}
