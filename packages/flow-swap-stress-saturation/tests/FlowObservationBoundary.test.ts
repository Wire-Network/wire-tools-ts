import * as Fs from "node:fs"

import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import {
  emptyPhaseResult,
  runSaturationRamp,
  type SwapStressCompletedObservation,
  type SwapStressIterationObservation
} from "@wireio/test-flow-swap-stress-saturation"

import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

describe("swap stress observation boundary", () => {
  it.each(["root", "evidence"] as const)(
    "rejects trapped %s reflection without leaking the sentinel",
    async target => {
      // Given: root or nested evidence reflection throws arbitrary code.
      const safe = completedObservation(),
        observation: SwapStressIterationObservation =
          target === "root"
            ? reflectionTrap(safe)
            : { ...safe, evidence: reflectionTrap(safe.evidence) }

      // When: the observation crosses generic deferred mode.
      const result = await runSaturationRamp({
        config: Config,
        clock: () => 1,
        runIteration: async () => observation
      })

      // Then: reflection becomes a no-observation invalid classification.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
    }
  )

  it("rejects nested phase accessors without invoking getters", async () => {
    // Given: one exact phase result has an accessor-backed health field.
    const observation = completedObservation(),
      phase = observation.evidence.phaseResults[0]
    if (phase === undefined) throw new Error("phase fixture missing")
    let getterCalls = 0
    Object.defineProperty(phase, "health", {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return null
      }
    })

    // When: recursive snapshotting reaches the nested descriptor.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: the getter never runs and no parsed observation exists.
    expect(getterCalls).toBe(0)
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("rejects arbitrary callback root keys", async () => {
    // Given: an otherwise exact completed root includes one unknown key.
    const observation = completedObservation()
    Object.defineProperty(observation, "status", {
      enumerable: true,
      value: "saturated"
    })

    // When: generic root parsing enforces the exact completed key set.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: the stale controller field is invalid observation data.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("keeps workload and telemetry-integrity categories exact", async () => {
    // Given: clean workload and degraded telemetry observations.
    const workload = breakageObservation(RampBreakageCategory.Workload),
      telemetry = breakageObservation(RampBreakageCategory.TelemetryIntegrity)

    // When: each observation runs through its own controller invocation.
    const workloadResult = await runSaturationRamp({
        config: Config,
        clock: () => 1,
        runIteration: async () => workload
      }),
      telemetryResult = await runSaturationRamp({
        config: Config,
        clock: () => 1,
        runIteration: async () => telemetry
      })

    // Then: both categories retain parsed observations and exact degradation data.
    expect(workloadResult.iterations[0]).toMatchObject({
      breakageCategory: RampBreakageCategory.Workload,
      observation: workload
    })
    expect(telemetryResult.iterations[0]).toMatchObject({
      breakageCategory: RampBreakageCategory.TelemetryIntegrity,
      observation: telemetry
    })
  })

  it("classifies arbitrary callback rejection as infrastructure", async () => {
    // Given: the flow callback rejects before producing an observation.
    const error = new Error("runner failed")

    // When: generic deferred mode settles the rejection.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: () => Promise.reject(error)
    })

    // Then: infrastructure owns the null observation and exact cause.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      cause: error,
      breakageCategory: RampBreakageCategory.Infrastructure
    })
  })

  it("performs no filesystem writes in deferred mode", async () => {
    // Given: every filesystem mutation primitive is observed.
    const writeFile = jest.spyOn(Fs.promises, "writeFile"),
      mkdir = jest.spyOn(Fs.promises, "mkdir"),
      rename = jest.spyOn(Fs.promises, "rename")

    // When: a complete generic deferred campaign runs.
    await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => completedObservation()
    })

    // Then: the controller stages no persistence before Todo23.
    expect(writeFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    writeFile.mockRestore()
    mkdir.mockRestore()
    rename.mockRestore()
  })
})

function completedObservation(): SwapStressCompletedObservation {
  return {
    kind: "completed",
    saturatedEndpoints: [
      RunEvidenceEndpoint.OutpostEthereumDepot,
      RunEvidenceEndpoint.DepotOutpostEthereum
    ],
    observedNonRequiredEndpoints: [],
    evidence: {
      phaseResults: [emptyPhaseResult("quote")],
      telemetryDegradation: null
    }
  }
}

function breakageObservation(
  category:
    RampBreakageCategory.Workload | RampBreakageCategory.TelemetryIntegrity
): SwapStressIterationObservation {
  const fields = {
    kind: "breakage" as const,
    saturatedEndpoints: [],
    observedNonRequiredEndpoints: [],
    breakageReason: "failed"
  }
  return category === RampBreakageCategory.Workload
    ? {
        ...fields,
        breakageCategory: category,
        evidence: { phaseResults: [], telemetryDegradation: null }
      }
    : {
        ...fields,
        breakageCategory: category,
        evidence: {
          phaseResults: [],
          telemetryDegradation: {
            kind: "baseline_capture_failed",
            issues: orderedBaselineCaptureIssues()
          }
        }
      }
}

function reflectionTrap<Value extends object>(value: Value): Value {
  return new Proxy(value, {
    ownKeys: () => {
      throw new TypeError("reflection sentinel")
    }
  })
}
