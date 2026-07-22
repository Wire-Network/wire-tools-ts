import { AtomicFile } from "@wireio/debugging-shared"
import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  verifyRunEvidence,
  type RunEvidenceDecimal,
  type RunEvidencePersistence,
  type RunEvidenceVerificationReport
} from "@wireio/test-opp-stress"

const RequiredEndpoints = [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ] as const,
  EmptyTelemetry = {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } as const

/** Canonical setup-failure preservation result consumed by cleanup. */
export type RealStressSetupFailureResult = {
  readonly lifecycle: RunEvidenceLifecycle.SetupFailed
  readonly preserveCluster: true
}

/** Runtime-only state when schema-v1 publication cannot truthfully complete. */
export type RealStressFailClosedResult = {
  readonly kind: "fail_closed"
  readonly lifecycle: RunEvidenceLifecycle | null
  readonly preserveCluster: true
  readonly cause: unknown
  readonly publicationError: AtomicFile.PublishError | null
  readonly evidenceDirectory: string
  readonly sourceConfigExists: boolean
  readonly verification: RunEvidenceVerificationReport
}

/** Settled promise result used at a persistence uncertainty boundary. */
export type SettledRealStressPublication<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly cause: unknown }

/** Inputs for canonical failed-setup records and terminal publication. */
export type RealStressSetupFailurePublicationInput = {
  readonly persistence: RunEvidencePersistence
  readonly allocationStartedAtMs: RunEvidenceDecimal
  readonly startedAtMs: RunEvidenceDecimal
  readonly endedAtMs: RunEvidenceDecimal
  readonly configCreated: boolean
  readonly cause: unknown
}

/** Convert one publication promise into an explicit success-or-cause result. */
export function settleRealStressPublication<Result>(
  publication: Promise<Result>
): Promise<SettledRealStressPublication<Result>> {
  return publication.then(
    value => ({ ok: true, value }),
    cause => ({ ok: false, cause })
  )
}

/** Publish canonical failed-setup evidence or return the first publication cause. */
export async function publishRealStressSetupFailure(
  input: RealStressSetupFailurePublicationInput
): Promise<
  | { readonly ok: true; readonly result: RealStressSetupFailureResult }
  | { readonly ok: false; readonly cause: unknown }
> {
  if (input.configCreated) {
    const capture = await settleRealStressPublication(
      input.persistence.captureClusterConfig()
    )
    if (!capture.ok) return capture
  }
  const reason = errorMessage(input.cause),
    setup = await settleRealStressPublication(
      input.persistence.publishSetup({
        schemaVersion: RunEvidenceSchemaVersion,
        stage: RunEvidenceStage.Setup,
        status: RunEvidenceSetupStatus.Failed,
        startedAtMs: input.startedAtMs,
        endedAtMs: input.endedAtMs,
        clusterConfigCreated: input.configCreated,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: reason
      })
    )
  if (!setup.ok) return setup
  const terminal = await settleRealStressPublication(
    input.persistence.publishTerminal({
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Terminal,
      lifecycle: RunEvidenceLifecycle.SetupFailed,
      startedAtMs: input.allocationStartedAtMs,
      endedAtMs: input.endedAtMs,
      requiredEndpoints: RequiredEndpoints,
      saturatedEndpoints: [],
      missingEndpoints: RequiredEndpoints,
      endpointResults: RequiredEndpoints.map(endpoint => ({
        endpoint,
        telemetry: EmptyTelemetry,
        saturated: false
      })),
      telemetry: EmptyTelemetry,
      iterationRefs: [],
      preserveCluster: true,
      breakageCategory: RampBreakageCategory.Infrastructure,
      breakageReason: reason
    })
  )
  if (!terminal.ok) return terminal
  return {
    ok: true,
    result: {
      lifecycle: RunEvidenceLifecycle.SetupFailed,
      preserveCluster: true
    }
  }
}

/** Snapshot precise public verifier and AtomicFile diagnostics for runtime cleanup. */
export function createRealStressFailClosedResult(input: {
  readonly persistence: RunEvidencePersistence
  readonly cause: unknown
  readonly sourceConfigExists: boolean
}): RealStressFailClosedResult {
  const verification = verifyRunEvidence(input.persistence.runDirectory)
  return {
    kind: "fail_closed",
    lifecycle: verification.lifecycle,
    preserveCluster: true,
    cause: input.cause,
    publicationError:
      input.cause instanceof AtomicFile.PublishError ? input.cause : null,
    evidenceDirectory: input.persistence.runDirectory,
    sourceConfigExists: input.sourceConfigExists,
    verification
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
