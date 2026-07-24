import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import {
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceSchemaVersion,
  RunEvidenceStage
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceIterationRecordRef,
  RunEvidenceTerminalRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type {
  RunEvidenceIteration,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"

const EmptyTelemetry = Object.freeze({
  kind: OppEnvelopeTelemetryHealthKind.Empty,
  retryable: true,
  candidateCount: 0,
  validCount: 0,
  filteredCount: 0,
  issueCount: 0,
  issues: Object.freeze([])
})

/** Store operations and snapshots required for one authoritative finalization. */
export type RunEvidenceInfrastructureFinalizerContext = {
  readonly manifest: () => RunEvidenceManifest
  readonly iterations: () => readonly RunEvidenceIteration[]
  readonly iterationRefs: () => readonly RunEvidenceIterationRecordRef[]
  readonly fatalCause: () => unknown | null
  readonly close: (cause: unknown) => void
  readonly publishIteration: (
    input: RunEvidenceIteration
  ) => Promise<RunEvidenceIterationRecordRef>
  readonly publishTerminal: (
    input: RunEvidenceTerminal
  ) => Promise<RunEvidenceTerminalRecordRef>
}

/** Idempotent running-lifecycle infrastructure finalization authority. */
export class RunEvidenceInfrastructureFinalizer {
  private finalization: Promise<RunEvidencePersistence.InfrastructureFailureResult> | null =
    null

  /** @param context Serialized persistence snapshots and publication operations. */
  constructor(private readonly context: RunEvidenceInfrastructureFinalizerContext) {}

  /** Finalize once, or expose the exact cause that already closed publication. */
  finalize(
    input: RunEvidencePersistence.InfrastructureFailureInput
  ): Promise<RunEvidencePersistence.InfrastructureFailureResult> {
    if (this.finalization !== null) return this.finalization
    const operation = this.finalizeOnce(input)
    this.finalization = operation
    return operation
  }

  private async finalizeOnce(
    input: RunEvidencePersistence.InfrastructureFailureInput
  ): Promise<RunEvidencePersistence.InfrastructureFailureResult> {
    const priorFatal = this.context.fatalCause()
    if (priorFatal !== null) return this.failClosed(priorFatal)
    const manifest = this.context.manifest(),
      last = this.context.iterations().at(-1)
    if (last?.outcome === RunEvidenceIterationOutcome.Saturated) {
      this.context.close(input.cause)
      return this.failClosed(input.cause)
    }
    const publication = await this.publishTerminalized(input, manifest, last).then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    if ("error" in publication) {
      const fatal = this.context.fatalCause()
      if (fatal !== null) return this.failClosed(fatal)
      this.context.close(publication.error)
      return this.failClosed(publication.error)
    }
    return publication.value
  }

  private async publishTerminalized(
    input: RunEvidencePersistence.InfrastructureFailureInput,
    manifest: RunEvidenceManifest,
    last: RunEvidenceIteration | undefined
  ): Promise<RunEvidencePersistence.TerminalizedInfrastructureFailure> {
    const iteration =
        last?.outcome === RunEvidenceIterationOutcome.Breakage
          ? last
          : await this.publishBreakage(input, manifest, last),
      terminal = terminalRecord(
        manifest,
        iteration,
        this.context.iterationRefs(),
        input
      ),
      terminalRef = await this.context.publishTerminal(terminal)
    return {
      kind: "terminalized",
      lifecycle: RunEvidenceLifecycle.Failed,
      preserveCluster: true,
      breakageCategory: RampBreakageCategory.Infrastructure,
      breakageReason: input.reason,
      cause: input.cause,
      iteration,
      terminal,
      terminalRef
    }
  }

  private async publishBreakage(
    input: RunEvidencePersistence.InfrastructureFailureInput,
    manifest: RunEvidenceManifest,
    previous: RunEvidenceIteration | undefined
  ): Promise<RunEvidenceIteration> {
    const endedAtMs = maximumDecimal(input.endedAtMs, manifest.updatedAtMs),
      saturatedEndpoints = manifest.saturatedEndpoints,
      iteration: RunEvidenceIteration = {
        schemaVersion: RunEvidenceSchemaVersion,
        stage: RunEvidenceStage.Iteration,
        iterationIndex: this.context.iterationRefs().length,
        accountCount: nextAccountCount(manifest, previous),
        startedAtMs: endedAtMs,
        endedAtMs,
        outcome: RunEvidenceIterationOutcome.Breakage,
        requiredEndpoints: manifest.requiredEndpoints,
        saturatedEndpoints,
        missingEndpoints: manifest.requiredEndpoints.filter(
          endpoint => !saturatedEndpoints.includes(endpoint)
        ),
        endpointResults: manifest.requiredEndpoints.map(endpoint => {
          const retained = previous?.endpointResults.find(
            result => result.endpoint === endpoint && result.saturated
          )
          return retained ?? { endpoint, telemetry: EmptyTelemetry, saturated: false }
        }),
        telemetry: EmptyTelemetry,
        phases: [],
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: input.reason
      }
    await this.context.publishIteration(iteration)
    return iteration
  }

  private failClosed(cause: unknown): RunEvidencePersistence.FailClosedResult {
    return {
      kind: "fail_closed",
      lifecycle: this.context.manifest().lifecycle,
      preserveCluster: true,
      cause
    }
  }
}

function terminalRecord(
  manifest: RunEvidenceManifest,
  iteration: RunEvidenceIteration,
  iterationRefs: readonly RunEvidenceIterationRecordRef[],
  input: RunEvidencePersistence.InfrastructureFailureInput
): RunEvidenceTerminal {
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Terminal,
    lifecycle: RunEvidenceLifecycle.Failed,
    startedAtMs: manifest.startedAtMs,
    endedAtMs: maximumDecimal(input.endedAtMs, iteration.endedAtMs),
    requiredEndpoints: manifest.requiredEndpoints,
    saturatedEndpoints: iteration.saturatedEndpoints,
    missingEndpoints: iteration.missingEndpoints,
    endpointResults: iteration.endpointResults,
    telemetry: iteration.telemetry,
    iterationRefs,
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: input.reason
  }
}

function nextAccountCount(
  manifest: RunEvidenceManifest,
  previous: RunEvidenceIteration | undefined
): number {
  if (previous === undefined) return manifest.rampConfig.initialCount
  const multiplied = BigInt(previous.accountCount) * BigInt(manifest.rampConfig.multiplier),
    maximum = BigInt(manifest.rampConfig.maxCount)
  return Number(multiplied < maximum ? multiplied : maximum)
}

function maximumDecimal(
  first: RunEvidenceDecimal,
  second: RunEvidenceDecimal
): RunEvidenceDecimal {
  return BigInt(first) >= BigInt(second) ? first : second
}
