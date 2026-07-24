import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  runOppStressRamp
} from "@wireio/test-opp-stress"

import {
  RampConfig,
  RequiredEndpoints
} from "./stressRampContractTestSupport.js"
import {
  completedEvidenceObservation,
  parseTestEvidence
} from "./stressRampDeferredEvidenceTestSupport.js"

describe("OPP stress ramp generic evidence traps", () => {
  it.each(["root", "evidence"] as const)(
    "rejects a trapped %s proxy before invoking the payload parser",
    async target => {
      // Given: reflection on either the root or nested evidence throws a sentinel.
      const safe = completedEvidenceObservation(["phase-1"])
      let trapCalls = 0,
        parserCalls = 0
      const observation: ReturnType<typeof completedEvidenceObservation> =
        target === "root"
          ? reflectionTrap(safe, () => {
              trapCalls += 1
            })
          : {
              ...safe,
              evidence: reflectionTrap(safe.evidence, () => {
                trapCalls += 1
              })
            }

      // When: the untrusted observation crosses the controller boundary.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: { ...RampConfig, maxCount: 1 },
        clock: () => 1,
        parseEvidence: (input, context) => {
          parserCalls += 1
          return parseTestEvidence(input, context)
        },
        runIteration: async () => observation
      })

      // Then: reflection is trapped, the parser never runs, and no sentinel escapes.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(trapCalls).toBe(1)
      expect(parserCalls).toBe(0)
    }
  )

  it("rejects nested evidence accessors without invoking getters", async () => {
    // Given: an otherwise typed evidence payload contains an accessor descriptor.
    const observation = completedEvidenceObservation(["phase-1"])
    let getterCalls = 0,
      parserCalls = 0
    Object.defineProperty(observation.evidence, "phaseResults", {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return ["sentinel"]
      }
    })

    // When: descriptor-safe recursive snapshotting reaches the nested payload.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      parseEvidence: (input, context) => {
        parserCalls += 1
        return parseTestEvidence(input, context)
      },
      runIteration: async () => observation
    })

    // Then: neither arbitrary getter code nor the payload parser executes.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
    expect(getterCalls).toBe(0)
    expect(parserCalls).toBe(0)
  })
})

function reflectionTrap<Value extends object>(
  value: Value,
  onTrap: () => void
): Value {
  return new Proxy(value, {
    ownKeys: () => {
      onTrap()
      throw new TypeError("reflection sentinel")
    }
  })
}
