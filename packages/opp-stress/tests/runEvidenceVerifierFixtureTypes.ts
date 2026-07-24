import type {
  OppEnvelopeTelemetryHealth,
  RunEvidenceArtifact,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidenceSaturationStrategy
} from "@wireio/test-opp-stress"

/** One generated phase specification for a verifier fixture. */
export type VerifierPhaseSpec = {
  readonly endpoint: RunEvidenceEndpoint
  readonly strategy: RunEvidenceSaturationStrategy
  readonly byteSize: number
  readonly epochEnvelopeIndex: number
  readonly telemetry?: OppEnvelopeTelemetryHealth
}

/** Options for one isolated schema-v1 verifier fixture. */
export type VerifierFixtureOptions = {
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
export type VerifierFixture = {
  readonly runDirectory: string
  readonly cleanup: () => void
}

/** Normalized inputs passed to lifecycle-record fixture builders. */
export type VerifierRecordBuildInput = {
  readonly lifecycle: RunEvidenceLifecycle
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly phases: readonly VerifierPhaseSpec[]
  readonly accountCount: number
  readonly configCreatedBeforeSetupFailure: boolean
  readonly breakagePhaseTelemetry?: OppEnvelopeTelemetryHealth
}

/** Immutable refs and state projected into a fixture manifest. */
export type BuiltVerifierRecords = {
  readonly setupRef: unknown
  readonly iterationRefs: readonly {
    readonly path: string
    readonly sha256: string
  }[]
  readonly terminalRef: {
    readonly path: string
    readonly sha256: string
  } | null
  readonly artifacts: readonly RunEvidenceArtifact[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly telemetry: OppEnvelopeTelemetryHealth
  readonly configSnapshot: unknown
}
