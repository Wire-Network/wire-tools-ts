import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidencePath,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceIteration,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"
import type { OppStressRampIterationObservation } from "@wireio/test-opp-stress"

import {
  createSchemaRampHarness,
  schemaObservation
} from "./stressRampSchemaV1TestSupport.js"

const Endpoint = RunEvidenceEndpoint.OutpostEthereumDepot,
  Sentinel = "REFLECTION_SENTINEL",
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp observation reflection traps", () => {
  it.each([
    ["root getPrototypeOf", rootPrototypeTrap, [2, 0, 0]],
    ["root ownKeys", rootOwnKeysTrap, [0, 2, 0]],
    ["root getOwnPropertyDescriptor", rootDescriptorTrap, [0, 0, 1]],
    ["nested getPrototypeOf", nestedPrototypeTrap, [1, 0, 0]]
  ] as const)(
    "finalizes %s as invalid observation",
    async (_, trap, expected) => {
      // Given: a real schema callback returns a proxy at one reflection boundary.
      const harness = await createSchemaRampHarness(Config, [Endpoint]),
        clock = jest.fn().mockReturnValueOnce(103).mockReturnValueOnce(104)
      let trapped: TrappedObservation | null = null
      try {
        // When: the controller snapshots the resolved callback value.
        const result = await runOppStressRamp({
          evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
          persistence: harness.persistence,
          clock,
          runIteration: async input => {
            const observation = await schemaObservation({
              ...harness,
              requiredEndpoints: [Endpoint],
              iterationIndex: input.iterationIndex,
              accountCount: input.accountCount,
              saturatedEndpoints: [Endpoint]
            })
            trapped = trap(observation)
            return trapped.value
          }
        })

        // Then: only the trapped operation runs and sentinel data never escapes.
        expect(clock).toHaveBeenCalledTimes(2)
        expect(trapped?.counts()).toEqual(expected)
        const summary = result.iterations[0]
        if (summary === undefined || !("cause" in summary))
          throw new Error("boundary failure summary expected")
        expect(summary.breakageCategory).toBe(
          RampBreakageCategory.InvalidObservation
        )
        expect(summary.breakageReason).not.toContain(Sentinel)
        const iteration = readIteration(harness.persistence.runDirectory)
        if (!("breakageReason" in iteration))
          throw new Error("failed iteration evidence expected")
        expect(iteration).toMatchObject({
          phases: [],
          breakageCategory: RampBreakageCategory.InvalidObservation
        })
        expect(iteration.breakageReason).not.toContain(Sentinel)
        expect(
          Fs.readFileSync(
            Path.join(
              harness.persistence.runDirectory,
              RunEvidencePath.Terminal
            ),
            "utf8"
          )
        ).not.toContain(Sentinel)
        expect(
          verifyRunEvidence(harness.persistence.runDirectory)
        ).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          verifiedSaturated: false
        })
      } finally {
        harness.cleanup()
      }
    }
  )
})

type TrapCounts = readonly [number, number, number]

type TrappedObservation = {
  readonly value: OppStressRampIterationObservation
  readonly counts: () => TrapCounts
}

function rootPrototypeTrap(
  observation: OppStressRampIterationObservation
): TrappedObservation {
  let prototypeCalls = 0
  return {
    value: new Proxy(observation, {
      getPrototypeOf: () => {
        prototypeCalls += 1
        throw new Error(Sentinel)
      }
    }),
    counts: () => [prototypeCalls, 0, 0]
  }
}

function rootOwnKeysTrap(
  observation: OppStressRampIterationObservation
): TrappedObservation {
  let ownKeyCalls = 0
  return {
    value: new Proxy(observation, {
      ownKeys: () => {
        ownKeyCalls += 1
        throw new Error(Sentinel)
      }
    }),
    counts: () => [0, ownKeyCalls, 0]
  }
}

function rootDescriptorTrap(
  observation: OppStressRampIterationObservation
): TrappedObservation {
  let descriptorCalls = 0
  return {
    value: new Proxy(observation, {
      getOwnPropertyDescriptor: () => {
        descriptorCalls += 1
        throw new Error(Sentinel)
      }
    }),
    counts: () => [0, 0, descriptorCalls]
  }
}

function nestedPrototypeTrap(
  observation: OppStressRampIterationObservation
): TrappedObservation {
  let prototypeCalls = 0
  const endpointTelemetry = observation.endpointTelemetry[0]
  if (endpointTelemetry === undefined)
    throw new Error("endpoint telemetry fixture expected")
  const nested = new Proxy(endpointTelemetry, {
    getPrototypeOf: () => {
      prototypeCalls += 1
      throw new Error(Sentinel)
    }
  })
  if (!Reflect.set(observation.endpointTelemetry, "0", nested))
    throw new Error("nested proxy fixture assignment failed")
  return {
    value: observation,
    counts: () => [prototypeCalls, 0, 0]
  }
}

function readIteration(runDirectory: string) {
  const parsed = parseRunEvidenceIteration(
    JSON.parse(
      Fs.readFileSync(
        Path.join(runDirectory, RunEvidencePath.Iterations, "000000.json"),
        "utf8"
      )
    )
  )
  if ("error" in parsed) throw new Error("iteration fixture must parse")
  return parsed.value
}
