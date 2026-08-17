import type { EnvelopeBaseline, EnvelopeBaselineIdentity } from "../envelope-integrity/index.js"
import type { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeTelemetryObservation
} from "./envelopeMetrics.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceEndpoint,
  RunEvidencePhaseBaseline,
  RunEvidencePhaseWindow,
  RunEvidenceSaturationStrategy
} from "./oppPhaseVocabulary.js"

/** Baseline membership plus artifacts already persisted before phase work. */
export interface OppPhaseMetricBaseline extends EnvelopeBaseline {
  readonly artifactRefs: RunEvidencePhaseBaseline["artifactRefs"]
}

/** One immutable file committed by an artifact sink. */
export interface OppPhaseArtifactFile {
  /** Path of the committed immutable file. */
  readonly path: string
  /** Full lowercase SHA-256 digest of the committed bytes. */
  readonly sha256: string
}

/** First committed immutable data + metadata references for one OPP key. */
export interface RunEvidenceImmutableArtifactRefs {
  /** Immutable raw envelope-data file reference. */
  readonly data: OppPhaseArtifactFile
  /** Immutable envelope-metadata file reference. */
  readonly metadata: OppPhaseArtifactFile
}

/** One strict OPP sidecar pair offered to an artifact sink. */
export interface OppPhaseArtifactCapture {
  /** Canonical envelope storage key shared by the pair. */
  readonly baseKey: string
  /** Raw serialized envelope bytes. */
  readonly dataBytes: Buffer
  /** Raw sidecar metadata bytes. */
  readonly metadataBytes: Buffer
}

/** Ordinal-scoped capture API allocated before source collection begins. */
export interface OppPhaseEvidenceObservation {
  /** Monotonic ordinal identifying this observation. */
  readonly ordinal: RunEvidenceDecimal
  /** Commit one sidecar pair, returning its immutable references. */
  readonly captureArtifact: (
    request: OppPhaseArtifactCapture
  ) => Promise<RunEvidenceImmutableArtifactRefs>
}

/**
 * Narrow artifact-capture capability accepted by the generic phase collector.
 *
 * Declared structurally rather than projected off a concrete persistence class
 * so the measurement layer owns its own contract — any sink satisfying this
 * shape (a run-evidence store, a Report-adjacent artifact directory, a test
 * double) can be supplied without the collector depending on it.
 */
export interface OppPhaseEvidenceSink {
  /** Allocate an ordinal-scoped observation for one collection pass. */
  readonly beginObservation: (
    updatedAtMs: RunEvidenceDecimal
  ) => OppPhaseEvidenceObservation
}

/** Strict envelope collector request for a named OPP workload phase. */
export interface OppPhaseMetricRequest {
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
  /**
   * Minimum raw envelope bytes classified as saturated under `byte_threshold`;
   * omission selects the engine's 95%-of-cap default. A campaign running at a
   * lighter {@link LoadProfile} level lowers it so saturation is judged against
   * THAT campaign's target rather than the protocol maximum.
   */
  readonly saturatedEnvelopeMinBytes?: number
  /** Caller-captured pre-phase membership and artifact correlation. */
  readonly baseline: OppPhaseMetricBaseline
  /** Explicit null disables artifact recording and ordinal allocation. */
  readonly evidenceSink: OppPhaseEvidenceSink | null
}

/** Stable source diagnostics for one pair selected into phase metrics. */
export interface OppPhaseSelectedArtifact {
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
export interface OppPhaseCapturedArtifact {
  /** Canonical OPP sidecar base key. */
  readonly baseKey: string
  /** Complete immutable data and metadata path/hash references. */
  readonly immutableRefs: RunEvidenceImmutableArtifactRefs
}

/** Baseline correlation returned when no evidence sink is present. */
export interface OppPhaseBaselineReference {
  /** Content identity shared by every probe using this baseline. */
  readonly identity: EnvelopeBaselineIdentity
  /** Immutable artifacts already represented by the baseline. */
  readonly artifactRefs: readonly string[]
}

/** Correlation-only evidence produced when no observation was allocated. */
interface OppPhaseUnrecordedEvidence {
  /** No observation was allocated and no artifact refs were fabricated. */
  readonly kind: "not_recorded"
  /** Caller-provided baseline correlation without an ordinal. */
  readonly baseline: OppPhaseBaselineReference
}

/** Recorded evidence carrying an allocated ordinal and immutable artifacts. */
interface OppPhaseRecordedEvidence {
  /** A real observation ordinal was allocated before strict scanning. */
  readonly kind: "recorded"
  /** Schema-assignable baseline and observation identity. */
  readonly baseline: RunEvidencePhaseBaseline
  /** Grouped full immutable refs in metric order. */
  readonly artifacts: readonly OppPhaseCapturedArtifact[]
  /** Data then metadata paths for each captured artifact in metric order. */
  readonly artifactRefs: readonly string[]
}

/** Recorded or correlation-only evidence for one metric observation. */
export type OppPhaseMetricEvidence =
  | OppPhaseUnrecordedEvidence
  | OppPhaseRecordedEvidence

/** Complete generic phase metrics and independent verification inputs. */
export interface OppPhaseEnvelopeMetrics {
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
