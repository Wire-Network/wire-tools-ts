import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { createSwapStressPhaseRunner } from "@wireio/test-flow-swap-stress-saturation"
import type {
  Phase2SwapRequest,
  StressRampConfig,
  StressRampIterationOutcome,
  SwapStressPhase,
  SwapStressPhaseRunnerDeps,
  SwapStressReservePairSnapshot
} from "@wireio/test-flow-swap-stress-saturation"

/** Fast synthetic ramp constants used when no real cluster env is present. */
export const TestRampConfig: StressRampConfig = {
  initialCount: 2,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 5_000
}

/** Synthetic scenario controls for deterministic no-env ramp tests. */
export type ScenarioOptions = {
  readonly saturationCount: number | null
  readonly phase1FailureReason?: string
}

/** Synthetic scenario surface consumed by ramp-controller tests. */
export type Scenario = {
  readonly runIteration: (input: {
    readonly iterationIndex: number
    readonly accountCount: number
    readonly phaseTimeoutMs: number
  }) => Promise<StressRampIterationOutcome>
  readonly phase2Requests: readonly Phase2SwapRequest[]
}

/** Create a deterministic synthetic phase-runner scenario. */
export function createScenario(options: ScenarioOptions): Scenario {
  let activeAccountCount = 0
  const phase2Requests: Phase2SwapRequest[] = [],
    deps = createDeps(options, () => activeAccountCount, phase2Requests),
    runner = createSwapStressPhaseRunner(deps)
  return {
    phase2Requests,
    runIteration: async input => {
      activeAccountCount = input.accountCount
      const outcome = await runner.runIteration(input.accountCount)
      return {
        ...outcome,
        iterationIndex: input.iterationIndex,
        accountCount: input.accountCount
      }
    }
  }
}

/** Create a per-test evidence directory under the OS temp directory. */
export function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(
    Path.join(OS.tmpdir(), `swap-stress-saturation-${label}-`)
  )
}

/** Read one synthetic ramp evidence JSON file. */
export function readEvidence(
  evidenceDir: string,
  iterationIndex: number
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    Fs.readFileSync(
      Path.join(evidenceDir, `iteration-${iterationIndex}.json`),
      "utf-8"
    )
  )
  return isRecord(parsed) ? parsed : {}
}

function createDeps(
  options: ScenarioOptions,
  accountCount: () => number,
  phase2Requests: Phase2SwapRequest[]
): SwapStressPhaseRunnerDeps {
  return {
    route: {
      ethereumChainCode: 1n,
      ethereumTokenCode: 2n,
      solanaChainCode: 3n,
      solanaTokenCode: 4n,
      wireChainCode: 5n,
      wireTokenCode: 6n,
      wireSentinelReserveCode: 7n,
      privateReserveCode: 8n
    },
    readReservePairSnapshot: async () => ReserveSnapshot,
    getEthereumFirstNonce: async () => 20,
    ethereumReserveManager: {
      requestSwap: async (
        _sourceToken,
        _sourceReserve,
        _targetChain,
        _targetToken,
        _targetReserve,
        _recipient,
        _targetAmount,
        _tolerance,
        overrides
      ) => {
        if (
          options.phase1FailureReason !== undefined &&
          overrides.nonce === 21
        ) {
          throw new Error(options.phase1FailureReason)
        }
        return {
          wait: async () => ({
            status: 1,
            hash: `0x${overrides.nonce}`,
            blockNumber: overrides.nonce,
            gasUsed: BigInt(overrides.nonce)
          })
        }
      }
    },
    submitPhase2Swap: async request => {
      phase2Requests.push(request.request)
      return `synthetic-solana-signature-${request.index}`
    },
    recipientPayoutObserver: payoutObserver(),
    returnPayoutObserver: payoutObserver(),
    collectEnvelopeMetrics: async request =>
      metricsForPhase(request.phase, accountCount(), options.saturationCount),
    clock: syntheticClock(),
    concurrency: 2
  }
}

const ReserveSnapshot: SwapStressReservePairSnapshot = {
  ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
  solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
}

function payoutObserver(): SwapStressPhaseRunnerDeps["recipientPayoutObserver"] {
  return {
    waitForPayouts: async request => ({
      ...request,
      observedCount: request.minimumObservedCount
    })
  }
}

function metricsForPhase(
  phase: SwapStressPhase,
  accountCount: number,
  saturationCount: number | null
): Awaited<
  ReturnType<
    Exclude<SwapStressPhaseRunnerDeps["collectEnvelopeMetrics"], undefined>
  >
> {
  const saturated =
      phase === "phase-2" &&
      saturationCount !== null &&
      accountCount >= saturationCount,
    endpointsType =
      phase === "phase-1"
        ? DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        : DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT
  return {
    phase,
    saturated,
    envelopeCount: saturated ? 2 : 1,
    envelopeByteSizes: saturated ? [256, 512] : [256],
    endpoint: DebugOutpostEndpointsType[endpointsType],
    epochStart: 42,
    epochEnd: 43
  }
}

function syntheticClock(): () => number {
  let tick = 0
  return () => 1_000_000 + tick++ * 10
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
