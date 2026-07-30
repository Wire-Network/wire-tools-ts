import type {
  OppEnvelopeTelemetryHealth,
  RunEvidenceArtifact,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidenceSaturationStrategy
} from "@wireio/test-opp-stress"

/** One generated phase specification for a verifier fixture. */
export interface VerifierPhaseSpec {
  readonly endpoint: RunEvidenceEndpoint
  readonly strategy: RunEvidenceSaturationStrategy
  readonly byteSize: number
  readonly epochEnvelopeIndex: number
  readonly telemetry?: OppEnvelopeTelemetryHealth
}

/** Options for one isolated schema-v1 verifier fixture. */
export interface VerifierFixtureOptions {
  readonly lifecycle?: RunEvidenceLifecycle
  readonly requiredEndpoints?: readonly RunEvidenceEndpoint[]
  readonly phases?: readonly VerifierPhaseSpec[]
  readonly initialCount?: number
  readonly maxCount?: number
  readonly accountCount?: number
  readonly configCreatedBeforeSetupFailure?: boolean
  readonly breakagePhaseTelemetry?: OppEnvelopeTelemetryHealth
}

/** Isolated run directory and cleanup contract for verifier tests. */
export interface VerifierFixture {
  readonly runDirectory: string
  readonly cleanup: () => void
}

/** Normalized inputs passed to lifecycle-record fixture builders. */
export interface VerifierRecordBuildInput {
  readonly lifecycle: RunEvidenceLifecycle
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly phases: readonly VerifierPhaseSpec[]
  readonly accountCount: number
  readonly configCreatedBeforeSetupFailure: boolean
  readonly breakagePhaseTelemetry?: OppEnvelopeTelemetryHealth
}

/** Immutable path and digest ref for one written fixture record. */
export interface VerifierRecordRef {
  readonly path: string
  readonly sha256: string
}

/** Immutable refs and state projected into a fixture manifest. */
export interface BuiltVerifierRecords {
  readonly setupRef: unknown
  readonly iterationRefs: readonly VerifierRecordRef[]
  readonly terminalRef: VerifierRecordRef | null
  readonly artifacts: readonly RunEvidenceArtifact[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly telemetry: OppEnvelopeTelemetryHealth
  readonly configSnapshot: unknown
}
