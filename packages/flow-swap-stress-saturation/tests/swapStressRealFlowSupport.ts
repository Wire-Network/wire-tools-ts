import * as Fs from "node:fs"
import * as Path from "node:path"

import { ProcessManager, log } from "@wireio/test-cluster-tool"
import {
  runSaturationRamp
} from "@wireio/test-flow-swap-stress-saturation"
import {
  RunEvidenceEndpoint,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"

import { RealRamp, Timing } from "./real/realFlowConstants.js"
import { createRealStressFlow } from "./real/realFlowSetup.js"
import { requireFlow, requiredEnvPresent } from "./real/realFlowUtils.js"
import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import { runRealIteration } from "./real/realStressRunner.js"
import type { RealStressFlow } from "./real/realFlowTypes.js"
import type {
  StressRampResult,
  SwapStressIterationObservation
} from "@wireio/test-flow-swap-stress-saturation"

type RealStressFlowCleanupFlow = {
  readonly context: {
    readonly clusterPath: string
    readonly teardown: () => Promise<void>
  }
}

type RealStressFlowCleanupDeps = {
  readonly killAll: () => Promise<void>
  readonly warn: (message: string) => void
  readonly removeCluster: (clusterPath: string) => Promise<void>
}

type RealStressFlowCleanupInput = {
  readonly flow: RealStressFlowCleanupFlow | null
  readonly result: { readonly preserveCluster: boolean } | null
  readonly cleanup?: RealStressFlowCleanupDeps
}

/** Format a real baseline outcome for assertion failures, including BigInt fields. */
export function formatRealBaselineOutcome(
  outcome: SwapStressIterationObservation
): string {
  return JSON.stringify(outcome, realBaselineOutcomeReplacer, 2)
}

/** Format a real ramp result for assertion failures, including BigInt fields. */
export function formatRealRampResult(result: StressRampResult): string {
  return JSON.stringify(result, realBaselineOutcomeReplacer, 2)
}

/**
 * Clean up real stress-flow resources while preserving setup-failure cluster data.
 * @param input Cleanup state and optional test collaborators.
 * @return Resolves after owned child processes have been stopped when required.
 */
export async function cleanupRealStressFlow(
  input: RealStressFlowCleanupInput
): Promise<void> {
  const cleanup = input.cleanup ?? {
    killAll: () => ProcessManager.get().killAll(),
    warn: (message: string) => log.warn(message),
    removeCluster: clusterPath =>
      Fs.promises.rm(clusterPath, { recursive: true, force: true })
  }

  if (input.flow === null) {
    await cleanup.killAll()
    return
  }
  if (input.result?.preserveCluster === true) {
    cleanup.warn(
      `[SwapStressSaturation] preserving cluster at ${input.flow.context.clusterPath}`
    )
  }
  const teardownFailure = await input.flow.context
      .teardown()
      .then(
        () => null,
        error => error
      ),
    processFailure = await cleanup.killAll().then(
      () => null,
      error => error
    )
  if (processFailure !== null) {
    if (teardownFailure !== null)
      throw new AggregateError(
        [teardownFailure, processFailure],
        "real stress teardown and process cleanup failed"
      )
    throw processFailure
  }
  if (teardownFailure !== null) throw teardownFailure
  if (input.result?.preserveCluster === false)
    await cleanup.removeCluster(input.flow.context.clusterPath)
}

/** Register the env-gated local-cluster swap stress baseline flow. */
export function describeRealSwapStressSaturationFlow(): void {
  const describeCluster = requiredEnvPresent() ? describe : describe.skip

  describeCluster("Flow: swap stress baseline real local cluster", () => {
    let flow: RealStressFlow | null = null
    let lifecycle: RealStressFlowLifecycle | null = null

    beforeAll(async () => {
      const clusterPath = realStressClusterPath()
      lifecycle = await RealStressFlowLifecycle.allocate({
        clusterPath,
        rampConfig: RealRamp.Config,
        requiredEndpoints: [
          RunEvidenceEndpoint.OutpostEthereumDepot,
          RunEvidenceEndpoint.DepotOutpostEthereum
        ],
        provenance: realStressProvenance(),
        startedAtMs: `${BigInt(Date.now())}`
      })
      const setup = await lifecycle.setup(createRealStressFlow)
      if (setup.kind === "failed") throw setup.cause
      flow = setup.flow
    }, Timing.RealSaturationRampTimeoutMs)

    afterAll(async () => {
      const finalizationFailure = await (
          lifecycle?.finalizeInfrastructureFailure(
            new RealStressNormalExitError()
          ) ?? Promise.resolve(null)
        ).then(
          () => null,
          error => error
        ),
        cleanupFailure = await cleanupRealStressFlow({
          flow,
          result: lifecycle?.canonicalResult ?? null
        }).then(
          () => null,
          error => error
        )
      if (finalizationFailure !== null && cleanupFailure !== null)
        throw new AggregateError(
          [finalizationFailure, cleanupFailure],
          "real stress evidence finalization and cleanup failed"
        )
      if (finalizationFailure !== null) throw finalizationFailure
      if (cleanupFailure !== null) throw cleanupFailure
    }, 30_000)

    test("WIRE chain is producing blocks", async () => {
      await requireLifecycle(lifecycle).runGuarded(async () => {
        const info = await requireFlow(flow).context.wireClient.getInfo()
        expect(Number(info.head_block_num)).toBeGreaterThan(0)
      })
    })

    test(
      "runs the private-reserve saturation ramp until both Ethereum OPP directions saturate",
      async () => {
        const activeFlow = requireFlow(flow),
          activeLifecycle = requireLifecycle(lifecycle),
          result = await activeLifecycle.ramp(() =>
            runSaturationRamp({
              persistence: activeLifecycle.persistence,
              config: RealRamp.Config,
              runIteration: input =>
                runRealIteration(activeFlow, input, activeLifecycle.persistence)
            })
          )
        if (result.status !== "saturated") {
          throw new Error(
            `expected real saturation, received:\n${formatRealRampResult(result)}`
          )
        }
        expect(result.missingEndpoints).toEqual([])
      },
      Timing.RealSaturationRampTimeoutMs
    )
  })
}

function realStressClusterPath(): string {
  return (
    process.env.WIRE_CLUSTER_PATH ??
    Path.join("/tmp", `wire-swap-stress-${process.pid}`)
  )
}

function realStressProvenance(): RunEvidencePersistence.AllocationOptions["provenance"] {
  return {
    wireBuildPath: requireEnv("WIRE_BUILD_PATH"),
    ethereumPath: requireEnv("WIRE_ETH_PATH"),
    solanaPath: requireEnv("WIRE_SOLANA_PATH")
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "")
    throw new Error(`required real stress environment variable missing: ${name}`)
  return value
}

function requireLifecycle(
  lifecycle: RealStressFlowLifecycle | null
): RealStressFlowLifecycle {
  if (lifecycle === null) throw new Error("real stress lifecycle was not allocated")
  return lifecycle
}

function realBaselineOutcomeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

class RealStressNormalExitError extends Error {
  readonly name = "RealStressNormalExitError"

  constructor() {
    super("real stress suite exited before a terminal ramp decision")
  }
}
