import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceLifecycle,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  RunEvidencePersistence,
  type RunEvidenceDecimal
} from "@wireio/test-opp-stress"
import type { StressRampResult } from "@wireio/test-flow-swap-stress-saturation"
import {
  createRealStressFailClosedResult,
  publishRealStressSetupFailure,
  settleRealStressPublication,
  type RealStressFailClosedResult,
  type RealStressSetupFailureResult
} from "./realFlowFailureOutcome.js"

/** Deterministic seams for allocation and setup lifecycle tests. */
export type RealStressFlowLifecycleDependencies = {
  readonly persistence?: RunEvidencePersistence.Dependencies
  readonly clock?: () => number
  readonly configExists?: (path: string) => boolean
}

/** Successful or canonically terminalized setup outcome. */
export type RealStressFlowSetupOutcome<Flow> =
  | { readonly kind: "succeeded"; readonly flow: Flow }
  | {
      readonly kind: "failed"
      readonly cause: unknown
      readonly result:
        | RealStressSetupFailureResult
        | RealStressFailClosedResult
    }

type RealStressFlowSource = {
  readonly context: { readonly clusterPath: string }
}

/** Error raised when fresh flow creation returns a different cluster source root. */
export class RealStressClusterPathMismatchError extends Error {
  readonly name = "RealStressClusterPathMismatchError"

  /** @param expected Allocation-owned root. @param actual Created flow root. */
  constructor(readonly expected: string, readonly actual: string) {
    super(`real stress flow cluster path ${actual} differs from ${expected}`)
  }
}

/** Canonical cleanup authority after setup, ramp, or fail-closed publication. */
export type RealStressCanonicalResult =
  | StressRampResult
  | RealStressSetupFailureResult
  | RunEvidencePersistence.TerminalizedInfrastructureFailure
  | RealStressFailClosedResult

/** One allocated external evidence run across setup and ramp. */
export class RealStressFlowLifecycle {
  private terminalResult: RealStressCanonicalResult | null = null
  private finalization: Promise<RealStressCanonicalResult> | null = null

  private constructor(
    readonly persistence: RunEvidencePersistence,
    readonly clusterPath: string,
    private readonly allocationStartedAtMs: RunEvidenceDecimal,
    private readonly clock: () => number,
    private readonly configExists: (path: string) => boolean
  ) {}

  /** Allocate and publish the initializing manifest before setup begins. */
  static async allocate(
    options: RunEvidencePersistence.AllocationOptions,
    dependencies: RealStressFlowLifecycleDependencies = {}
  ): Promise<RealStressFlowLifecycle> {
    const persistence = await RunEvidencePersistence.allocate(
      options,
      dependencies.persistence
    )
    return new RealStressFlowLifecycle(
      persistence,
      persistence.clusterPath,
      options.startedAtMs,
      dependencies.clock ?? Date.now,
      dependencies.configExists ?? Fs.existsSync
    )
  }

  /** Canonical lowercase UUID-v4 allocated by persistence. */
  get runId(): string {
    return this.persistence.runId
  }

  /** Absolute external directory containing this run. */
  get runDirectory(): string {
    return this.persistence.runDirectory
  }

  /** Last canonical setup or ramp result, or null before terminal publication. */
  get canonicalResult(): RealStressCanonicalResult | null {
    return this.terminalResult
  }

  /** Run setup, capture config, and publish exactly one canonical setup exit. */
  async setup<Flow extends RealStressFlowSource>(
    createFlow: (clusterPath: string) => Promise<Flow>
  ): Promise<RealStressFlowSetupOutcome<Flow>> {
    const startedAtMs = decimalClock(this.clock()),
      setup = await createFlow(this.clusterPath).then(
        flow => ({ ok: true as const, flow }),
        cause => ({ ok: false as const, cause })
      )
    if (!setup.ok) return this.publishSetupFailure(startedAtMs, setup.cause)
    const actualPath = Path.resolve(setup.flow.context.clusterPath)
    if (actualPath !== this.clusterPath)
      return this.publishSetupFailure(
        startedAtMs,
        new RealStressClusterPathMismatchError(this.clusterPath, actualPath),
        false
      )
    const endedAtMs = decimalClock(this.clock())
    const capture = await settleRealStressPublication(
      this.persistence.captureClusterConfig()
    )
    if (!capture.ok) return this.failClosedSetup(capture.cause)
    const setupPublication = await settleRealStressPublication(
      this.persistence.publishSetup({
        schemaVersion: RunEvidenceSchemaVersion,
        stage: RunEvidenceStage.Setup,
        status: RunEvidenceSetupStatus.Succeeded,
        startedAtMs,
        endedAtMs,
        clusterConfigCreated: true
      })
    )
    if (!setupPublication.ok)
      return this.failClosedSetup(setupPublication.cause)
    return { kind: "succeeded", flow: setup.flow }
  }

  /** Run the canonical controller and retain only its returned terminal decision. */
  async ramp(run: () => Promise<StressRampResult>): Promise<StressRampResult> {
    const settled = await run().then(
      result => ({ ok: true as const, result }),
      cause => ({ ok: false as const, cause })
    )
    if (!settled.ok) {
      await this.finalizeInfrastructureFailure(settled.cause)
      throw settled.cause
    }
    const result = settled.result
    this.terminalResult = result
    return result
  }

  /** Run a normal suite action and finalize its rejection before rethrowing. */
  async runGuarded<Result>(run: () => Promise<Result>): Promise<Result> {
    const settled = await run().then(
      result => ({ ok: true as const, result }),
      cause => ({ ok: false as const, cause })
    )
    if (settled.ok) return settled.result
    await this.finalizeInfrastructureFailure(settled.cause)
    throw settled.cause
  }

  /** Finalize a normal exit once, retaining the first exact cause. */
  async finalizeInfrastructureFailure(
    cause: unknown
  ): Promise<RealStressCanonicalResult> {
    if (this.terminalResult !== null) return this.terminalResult
    if (this.finalization !== null) return this.finalization
    const operation = this.finalizeOnce(cause)
    this.finalization = operation
    return operation
  }

  private async publishSetupFailure(
    startedAtMs: RunEvidenceDecimal,
    cause: unknown,
    captureExistingConfig = true,
    knownEndedAtMs: RunEvidenceDecimal | null = null
  ): Promise<RealStressFlowSetupOutcome<never>> {
    const endedAtMs = knownEndedAtMs ?? decimalClock(this.clock()),
      configCreated = captureExistingConfig && this.configExists(
        Path.join(this.clusterPath, "cluster-config.json")
      )
    const publication = await publishRealStressSetupFailure({
      persistence: this.persistence,
      allocationStartedAtMs: this.allocationStartedAtMs,
      startedAtMs,
      endedAtMs,
      configCreated,
      cause
    })
    if (!publication.ok) return this.failClosedSetup(publication.cause)
    this.terminalResult = publication.result
    return { kind: "failed", cause, result: publication.result }
  }

  private async failClosedSetup(
    cause: unknown
  ): Promise<RealStressFlowSetupOutcome<never>> {
    const result = this.settleFailClosed(cause)
    return { kind: "failed", cause, result }
  }

  private async finalizeOnce(cause: unknown): Promise<RealStressCanonicalResult> {
    const finalization = await settleRealStressPublication(
      this.persistence.finalizeInfrastructureFailure({
        endedAtMs: decimalClock(this.clock()),
        reason: errorMessage(cause),
        cause
      })
    )
    if (!finalization.ok) return this.settleFailClosed(finalization.cause)
    if (finalization.value.kind === "fail_closed")
      return this.settleFailClosed(finalization.value.cause)
    this.terminalResult = finalization.value
    return finalization.value
  }

  private settleFailClosed(cause: unknown): RealStressFailClosedResult {
    const existing = this.terminalResult
    if (existing !== null && "kind" in existing && existing.kind === "fail_closed")
      return existing
    const result = createRealStressFailClosedResult({
      persistence: this.persistence,
      cause,
      sourceConfigExists: this.configExists(
          Path.join(this.clusterPath, "cluster-config.json")
        )
    })
    this.terminalResult = result
    return result
  }
}

function decimalClock(value: number): RunEvidenceDecimal {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("real stress lifecycle clock must be non-negative")
  return `${BigInt(value)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
