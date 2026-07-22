import {
  captureEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { sleep } from "@wireio/test-cluster-tool"
import { collectOppPhaseMetrics } from "@wireio/test-opp-stress"
import {
  classifyOppPhaseMetrics,
  pollRealFlowBaseline,
  pollRealFlowMetrics
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  RealBaselinePollingRuntime,
  SwapStressRealTelemetryDeps
} from "@wireio/test-flow-swap-stress-saturation"
import type { RunEvidencePersistence } from "@wireio/test-opp-stress"

const PhaseEpochStart = 0,
  PhaseEpochEnd = Number.MAX_SAFE_INTEGER

type RealPhaseTelemetryRuntime = Pick<
  RealBaselinePollingRuntime,
  "now" | "wait"
>

/**
 * Build real telemetry dependencies with canonical baseline-aware collection.
 *
 * @param clusterPath Canonical root of the running real cluster.
 * @param persistence Optional immutable run-evidence sink.
 * @param runtime Optional clock and wait injection for deterministic tests.
 * @returns Strict deadline-polled real telemetry dependencies.
 */
export function createRealPhaseTelemetryDependencies(
  clusterPath: string,
  persistence: RunEvidencePersistence | null = null,
  runtime: RealPhaseTelemetryRuntime = { now: Date.now, wait: sleep }
): SwapStressRealTelemetryDeps {
  return {
    telemetryKind: "real",
    captureEnvelopeBaseline: () =>
      pollRealFlowBaseline({
        ...runtime,
        capture: () => captureEnvelopeBaseline(oppDebuggingPath(clusterPath))
      }),
    collectEnvelopeMetrics: request => {
      const phaseBaseline = { ...request.baseline, artifactRefs: [] }
      return pollRealFlowMetrics(request, {
        ...runtime,
        collect: async retryRequest =>
          classifyOppPhaseMetrics(
            await collectOppPhaseMetrics(clusterPath, {
              phase: retryRequest.phase,
              startedAtMs: `${BigInt(retryRequest.startedAtMs)}`,
              endedAtMs: `${BigInt(retryRequest.endedAtMs)}`,
              epochStart: PhaseEpochStart,
              epochEnd: PhaseEpochEnd,
              endpointsType: retryRequest.endpointsType,
              baseline: phaseBaseline,
              evidenceSink: persistence
            })
          )
      })
    }
  }
}
