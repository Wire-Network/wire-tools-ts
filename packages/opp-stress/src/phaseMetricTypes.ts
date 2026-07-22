import type {
  EnvelopeBaseline,
  EnvelopeBaselineIdentity
} from "@wireio/debugging-shared"
import type { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeTelemetryObservation
} from "./envelopeMetrics.js"
import type { RunEvidencePersistence } from "./runEvidencePersistence.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceEndpoint,
  RunEvidenceImmutableArtifactRefs,
  RunEvidencePhaseBaseline,
  RunEvidencePhaseWindow,
  RunEvidenceSaturationStrategy
} from "./runEvidenceTypes.js"

/** Baseline membership plus artifacts already persisted before phase work. */
export type OppPhaseMetricBaseline = EnvelopeBaseline & {
  readonly artifactRefs: RunEvidencePhaseBaseline["artifactRefs"]
}

/** Narrow persistence capability accepted by the generic phase collector. */
export type OppPhaseEvidenceSink = Pick<
  RunEvidencePersistence,
  "beginObservation"
>

/** Strict envelope collector request for a named OPP workload phase. */
export type OppPhaseMetricRequest = {
  /** Phase whose observation window is measured. */
  readonly phase: string
  /** Inclusive observational phase start as a precision-safe decimal. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Inclusive observational phase end as a precision-safe decimal. */
  readonly endedAtMs: RunEvidenceDecimal
  /** Inclusive source epoch lower bound required for metric selection. */
  readonly epochStart: number
  /** Inclusive source epoch upper bound required for metric selection. */
  readonly epochEnd: number
  /** Endpoint direction expected to carry this phase's evidence. */
  readonly endpointsType: DebugOutpostEndpointsType
  /** Saturation classifier; omission selects rollover. */
  readonly saturationStrategy?: OppEnvelopeSaturationStrategy
  /** Caller-captured pre-phase membership and artifact correlation. */
  readonly baseline: OppPhaseMetricBaseline
  /** Explicit null disables artifact recording and ordinal allocation. */
  readonly evidenceSink: OppPhaseEvidenceSink | null
}

/** Stable source diagnostics for one pair selected into phase metrics. */
export type OppPhaseSelectedArtifact = {
  /** Canonical OPP sidecar base key. */
  readonly baseKey: string
  /** Source-side epoch parsed from the base key. */
  readonly epoch: number
  /** Envelope index within the source epoch. */
  readonly index: number
  /** Full strict-reader data digest. */
  readonly dataSha256: string
  /** Stable data descriptor mtime observed by the strict reader. */
  readonly dataMtimeNs: string
  /** Stable metadata descriptor mtime observed by the strict reader. */
  readonly metadataMtimeNs: string
}

/** First immutable refs returned for one selected OPP pair. */
export type OppPhaseCapturedArtifact = {
  /** Canonical OPP sidecar base key. */
  readonly baseKey: string
  /** Complete immutable data and metadata path/hash references. */
  readonly immutableRefs: RunEvidenceImmutableArtifactRefs
}

/** Baseline correlation returned when no evidence sink is present. */
export type OppPhaseBaselineReference = {
  /** Content identity shared by every probe using this baseline. */
  readonly identity: EnvelopeBaselineIdentity
  /** Immutable artifacts already represented by the baseline. */
  readonly artifactRefs: readonly string[]
}

/** Recorded or correlation-only evidence for one metric observation. */
export type OppPhaseMetricEvidence =
  | {
      /** No observation was allocated and no artifact refs were fabricated. */
      readonly kind: "not_recorded"
      /** Caller-provided baseline correlation without an ordinal. */
      readonly baseline: OppPhaseBaselineReference
    }
  | {
      /** A real observation ordinal was allocated before strict scanning. */
      readonly kind: "recorded"
      /** Schema-assignable baseline and observation identity. */
      readonly baseline: RunEvidencePhaseBaseline
      /** Grouped full immutable refs in metric order. */
      readonly artifacts: readonly OppPhaseCapturedArtifact[]
      /** Data then metadata paths for each captured artifact in metric order. */
      readonly artifactRefs: readonly string[]
    }

/** Complete generic phase metrics and independent verification inputs. */
export type OppPhaseEnvelopeMetrics = {
  /** Phase label these metrics describe. */
  readonly phase: string
  /** Canonical endpoint label persisted in run evidence. */
  readonly endpoint: RunEvidenceEndpoint
  /** Canonical saturation strategy persisted in run evidence. */
  readonly strategy: RunEvidenceSaturationStrategy
  /** Observational timestamp and selected epoch bounds. */
  readonly window: RunEvidencePhaseWindow
  /** Whether healthy matching records satisfy the selected strategy. */
  readonly saturated: boolean
  /** Whether a matching Solana envelope exceeds its raw transaction cap. */
  readonly solanaOversized: boolean
  /** Number of valid matching envelopes. */
  readonly envelopeCount: number
  /** Matching raw envelope byte sizes in metric order. */
  readonly envelopeByteSizes: readonly number[]
  /** Matching epoch-envelope indexes in metric order. */
  readonly epochEnvelopeIndexes: readonly number[]
  /** Exact strict-reader health and structured issues. */
  readonly health: OppEnvelopeTelemetryObservation
  /** Exact candidate issue summaries from the strict metric projection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
  /** Stable source diagnostics for represented metric pairs. */
  readonly selectedArtifacts: readonly OppPhaseSelectedArtifact[]
  /** Correlation-only or recorded immutable evidence. */
  readonly evidence: OppPhaseMetricEvidence
}
