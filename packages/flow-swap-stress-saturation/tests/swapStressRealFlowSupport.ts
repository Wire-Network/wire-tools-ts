import * as Fs from "node:fs"
import * as Path from "node:path"

import { ProcessManager, log } from "@wireio/test-cluster-tool"
import {
  emptyCampaignSaturation,
  runSaturationRamp
} from "@wireio/test-flow-swap-stress-saturation"

import { RealRamp, Timing } from "./real/realFlowConstants.js"
import { createRealStressFlow } from "./real/realFlowSetup.js"
import {
  evidenceDir,
  requireFlow,
  requiredEnvPresent
} from "./real/realFlowUtils.js"
import { runRealIteration } from "./real/realStressRunner.js"
import type { RealStressFlow } from "./real/realFlowTypes.js"
import type {
  StressRampResult,
  SwapStressIterationOutcome
} from "@wireio/test-flow-swap-stress-saturation"

type SetupFailureEvidence = {
  readonly kind: "failed_before_saturation"
  readonly iterationIndex: 0
  readonly accountCount: number
  readonly phase: "setup"
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly txSuccesses: 0
  readonly txFailures: 1
  readonly breakageReason: string
  readonly envelopeCount: 0
  readonly envelopeByteSizes: readonly number[]
  readonly endpoint: "setup"
  readonly epochStart: 0
  readonly epochEnd: 0
  readonly saturatedEndpoints: readonly string[]
  readonly missingEndpoints: readonly string[]
  readonly observedNonRequiredEndpoints: readonly string[]
  readonly status: "failed_before_saturation"
  readonly preserveCluster: true
  readonly config: typeof RealRamp.Config
}

type RealStressFlowCleanupFlow = {
  readonly context: {
    readonly clusterPath: string
    readonly teardown: () => Promise<void>
  }
}

type RealStressFlowCleanupDeps = {
  readonly killAll: () => Promise<void>
  readonly warn: (message: string) => void
}

type RealStressFlowCleanupInput = {
  readonly flow: RealStressFlowCleanupFlow | null
  readonly preserveCluster: boolean
  readonly setupFailed: boolean
  readonly cleanup?: RealStressFlowCleanupDeps
}

/** Write iteration-0 evidence when real-flow setup fails before the ramp starts. */
export async function writeSetupFailureEvidence(
  clusterPath: string,
  error: unknown
): Promise<void> {
  const timestampMs = Date.now(),
    campaign = emptyCampaignSaturation(),
    evidence: SetupFailureEvidence = {
      kind: "failed_before_saturation",
      iterationIndex: 0,
      accountCount: RealRamp.Config.initialCount,
      phase: "setup",
      startedAtMs: timestampMs,
      endedAtMs: timestampMs,
      txSuccesses: 0,
      txFailures: 1,
      breakageReason: `setup failed before saturation: ${errorMessage(error)}`,
      envelopeCount: 0,
      envelopeByteSizes: [],
      endpoint: "setup",
      epochStart: 0,
      epochEnd: 0,
      saturatedEndpoints: campaign.saturatedEndpoints,
      missingEndpoints: campaign.missingEndpoints,
      observedNonRequiredEndpoints: campaign.observedNonRequiredEndpoints,
      status: "failed_before_saturation",
      preserveCluster: true,
      config: RealRamp.Config
    },
    targetDir = evidenceDir(clusterPath)
  await Fs.promises.mkdir(targetDir, { recursive: true })
  await Fs.promises.writeFile(
    Path.join(targetDir, "iteration-0.json"),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
}

/** Format a real baseline outcome for assertion failures, including BigInt fields. */
export function formatRealBaselineOutcome(
  outcome: SwapStressIterationOutcome
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
    warn: (message: string) => log.warn(message)
  }

  if (input.setupFailed) {
    await cleanup.killAll()
    return
  }

  if (input.flow === null) return
  if (input.preserveCluster) {
    cleanup.warn(
      `[SwapStressSaturation] preserving cluster at ${input.flow.context.clusterPath}`
    )
    await input.flow.context.teardown()
    await cleanup.killAll()
    return
  }
  await input.flow.context.teardown()
  await cleanup.killAll()
}

/** Register the env-gated local-cluster swap stress baseline flow. */
export function describeRealSwapStressSaturationFlow(): void {
  const describeCluster = requiredEnvPresent() ? describe : describe.skip

  describeCluster("Flow: swap stress baseline real local cluster", () => {
    let flow: RealStressFlow | null = null
    let preserveCluster = true
    let setupFailed = false

    beforeAll(async () => {
      try {
        flow = await createRealStressFlow()
      } catch (error) {
        setupFailed = true
        await writeSetupFailureEvidence(realStressClusterPath(), error)
        throw error
      }
    }, Timing.RealSaturationRampTimeoutMs)

    afterAll(async () => {
      await cleanupRealStressFlow({ flow, preserveCluster, setupFailed })
    }, 30_000)

    test("WIRE chain is producing blocks", async () => {
      const info = await requireFlow(flow).context.wireClient.getInfo()
      expect(Number(info.head_block_num)).toBeGreaterThan(0)
    })

    test(
      "runs the private-reserve saturation ramp until both Ethereum OPP directions saturate",
      async () => {
        const activeFlow = requireFlow(flow),
          result = await runSaturationRamp({
            evidenceDir: evidenceDir(activeFlow.context.clusterPath),
            config: RealRamp.Config,
            runIteration: input => runRealIteration(activeFlow, input)
          })
        preserveCluster = result.preserveCluster
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function realBaselineOutcomeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}
