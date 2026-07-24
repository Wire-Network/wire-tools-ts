import * as Fs from "node:fs"

import * as OppStressApi from "@wireio/test-opp-stress"
import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  runOppStressRamp
} from "@wireio/test-opp-stress"

import {
  InvalidClockValueCases,
  InvalidEndClockCases,
  MaliciousObservationCases,
  RampConfig,
  RequiredEndpoints,
  completedObservation,
  makeEvidenceDir
} from "./stressRampContractTestSupport.js"

describe("OPP stress ramp boundary hardening", () => {
  it("keeps the iteration parser package-private", () => {
    // Given/When: a consumer inspects the package root.
    const hasParser = Object.hasOwn(
      OppStressApi,
      "parseOppStressRampIterationObservation"
    )

    // Then: only the flow-required typed error remains public.
    expect(hasParser).toBe(false)
    expect(typeof OppStressApi.OppStressRampInvalidObservationError).toBe(
      "function"
    )
  })

  it.each(MaliciousObservationCases)(
    "rejects malicious observation descriptors: %s",
    async (label, observation) => {
      // Given: an exotic callback object would bypass enumerable-key validation.
      const evidenceDir = makeEvidenceDir(`descriptor-${label}`)

      // When: the object reaches the controller boundary.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: { ...RampConfig, maxCount: 1 },
        clock: () => 1,
        runIteration: async () => observation()
      })

      // Then: it becomes a no-observation failure without writing evidence.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(Fs.readdirSync(evidenceDir)).toEqual([])
    }
  )

  it("rejects a stateful accessor without invoking its getter", async () => {
    // Given: a callback field returns valid data once and invalid data thereafter.
    const evidenceDir = makeEvidenceDir("stateful-accessor"),
      observation = completedObservation()
    let getterCalls = 0
    Object.defineProperty(observation, "txSuccesses", {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return getterCalls === 1 ? 1 : -1
      }
    })

    // When: the accessor-backed object reaches the controller boundary.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: descriptor inspection classifies it without evaluating arbitrary code.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
    expect(getterCalls).toBe(0)
    expect(Fs.readdirSync(evidenceDir)).toEqual([])
  })

  it("accepts a null-prototype exact data object", async () => {
    // Given: a valid callback object has no prototype.
    const evidenceDir = makeEvidenceDir("null-prototype"),
      observation = Object.setPrototypeOf(completedObservation(), null)

    // When: the controller parses and persists the exact data object.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: normal validation and evidence construction still apply.
    expect(result.iterations[0]).toMatchObject({ txSuccesses: 1 })
    expect(Fs.readdirSync(evidenceDir)).toEqual([])
  })

  it.each(InvalidClockValueCases)(
    "rejects an invalid start clock before callback: %s",
    async (_label, clockValue) => {
      // Given: the first controller clock read is invalid.
      const evidenceDir = makeEvidenceDir("invalid-start"),
        events: string[] = [],
        runIteration = jest.fn(async () => {
          events.push("callback")
          return completedObservation()
        })

      // When: the controller starts the iteration.
      const run = runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: { ...RampConfig, maxCount: 1 },
        clock: () => {
          events.push("clock-start")
          return clockValue
        },
        runIteration
      })

      // Then: typed validation precedes callback invocation and persistence.
      await expect(run).rejects.toMatchObject({
        reason: "clock startedAtMs must be a non-negative safe integer"
      })
      expect(events).toEqual(["clock-start"])
      expect(runIteration).not.toHaveBeenCalled()
      expect(Fs.readdirSync(evidenceDir)).toEqual([])
    }
  )

  it.each(InvalidEndClockCases)(
    "rejects an invalid end clock before observation parsing: %s",
    async (_label, endedAtMs, reason) => {
      // Given: callback resolution succeeds with an otherwise invalid custom prototype.
      const evidenceDir = makeEvidenceDir("invalid-end"),
        events: string[] = [],
        observation = Object.setPrototypeOf(completedObservation(), {
          inherited: true
        })
      let clockReads = 0

      // When: the second clock read is invalid or reverses the window.
      const run = runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: { ...RampConfig, maxCount: 1 },
        clock: () => {
          const value = clockReads === 0 ? 10 : endedAtMs
          events.push(clockReads === 0 ? "clock-start" : "clock-end")
          clockReads += 1
          return value
        },
        runIteration: async () => {
          events.push("callback")
          return observation
        }
      })

      // Then: clock validation wins before parser/aggregation/persistence.
      await expect(run).rejects.toMatchObject({ reason })
      expect(events).toEqual(["clock-start", "callback", "clock-end"])
      expect(Fs.readdirSync(evidenceDir)).toEqual([])
    }
  )

  it("returns deferred infrastructure failure after exactly two clock reads", async () => {
    // Given: the callback rejects after the valid start clock.
    const evidenceDir = makeEvidenceDir("callback-rejection"),
      callbackError = new Error("callback failed"),
      clock = jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(11),
      runIteration = jest.fn(() => Promise.reject(callbackError))

    // When: the callback rejects.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock,
      runIteration
    })

    // Then: the no-write mode returns the same truthful controller failure.
    expect(result).toMatchObject({
      status: "failed_before_saturation",
      preserveCluster: true,
      saturatedEndpoints: [],
      missingEndpoints: RequiredEndpoints
    })
    expect(result.iterations[0]).toMatchObject({
      kind: "breakage",
      observation: null,
      breakageCategory: RampBreakageCategory.Infrastructure,
      breakageReason: "callback failed",
      startedAtMs: 10,
      endedAtMs: 11,
      cause: callbackError
    })
    expect(result.iterations[0]).not.toHaveProperty("phase")
    expect(result.iterations[0]).not.toHaveProperty("txSuccesses")
    expect(clock).toHaveBeenCalledTimes(2)
    expect(runIteration).toHaveBeenCalledTimes(1)
    expect(Fs.readdirSync(evidenceDir)).toEqual([])
  })
})
