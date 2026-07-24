import * as Fs from "node:fs"

import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  runOppStressRamp
} from "@wireio/test-opp-stress"
import type {
  OppStressRampDeferredEvidenceBreakageObservation,
  OppStressRampDeferredEvidenceCompletedObservation,
  OppStressRampDeferredEvidenceIterationObservation
} from "@wireio/test-opp-stress"

import {
  RampConfig,
  RequiredEndpoints,
  completedObservation,
  makeEvidenceDir
} from "./stressRampContractTestSupport.js"
import {
  completedEvidenceObservation,
  parseTestEvidence,
  type TestEvidence
} from "./stressRampDeferredEvidenceTestSupport.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value
  >() => Value extends Right ? 1 : 2
    ? true
    : false

type Assert<Condition extends true> = Condition

type CompletedObservation =
  OppStressRampDeferredEvidenceCompletedObservation<TestEvidence>
type BreakageObservation =
  OppStressRampDeferredEvidenceBreakageObservation<TestEvidence>
type Observation =
  OppStressRampDeferredEvidenceIterationObservation<TestEvidence>

const CompletedKeysProof: Assert<
    Equal<
      keyof CompletedObservation,
      | "kind"
      | "saturatedEndpoints"
      | "observedNonRequiredEndpoints"
      | "evidence"
    >
  > = true,
  BreakageKeysProof: Assert<
    Equal<
      keyof BreakageObservation,
      | "kind"
      | "saturatedEndpoints"
      | "observedNonRequiredEndpoints"
      | "evidence"
      | "breakageCategory"
      | "breakageReason"
    >
  > = true,
  ForbiddenKeysProof: Assert<
    Equal<
      Extract<
        keyof Observation,
        | "iterationIndex"
        | "accountCount"
        | "startedAtMs"
        | "endedAtMs"
        | "status"
        | "preserveCluster"
        | "missingEndpoints"
        | "lifecycle"
      >,
      never
    >
  > = true,
  ObservationKindsProof: Assert<
    Equal<Observation["kind"], "completed" | "breakage">
  > = true,
  BreakageCategoryRequiredProof: Assert<
    Equal<
      Record<string, never> extends Pick<
        BreakageObservation,
        "breakageCategory"
      >
        ? true
        : false,
      false
    >
  > = true,
  BreakageReasonRequiredProof: Assert<
    Equal<
      Record<string, never> extends Pick<BreakageObservation, "breakageReason">
        ? true
        : false,
      false
    >
  > = true

describe("OPP stress ramp generic deferred evidence", () => {
  it("stamps controller metadata around an unchanged parsed observation", async () => {
    // Given: a typed payload parser, independent controller clock, and callback input log.
    const evidenceDir = makeEvidenceDir("generic-controller-fields"),
      callbackObservation = completedEvidenceObservation(["phase-1"]),
      events: string[] = [],
      clock = jest.fn().mockReturnValueOnce(101).mockReturnValueOnce(202)

    // When: the generic observation saturates the campaign.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock,
      parseEvidence: parseTestEvidence,
      runIteration: async input => {
        events.push(`${input.iterationIndex}:${input.accountCount}`)
        return callbackObservation
      }
    })

    // Then: only the controller supplies identity/lifecycle fields and payload data is exact.
    expect(events).toEqual(["0:1"])
    expect(result.iterations[0]).toMatchObject({
      iterationIndex: 0,
      accountCount: 1,
      startedAtMs: 101,
      endedAtMs: 202,
      status: "saturated",
      preserveCluster: false,
      observation: callbackObservation
    })
    expect(result.iterations[0]?.observation).toEqual(callbackObservation)
    expect(Fs.readdirSync(evidenceDir)).toEqual([])
  })

  it("keeps breakage terminal when every endpoint is saturated", async () => {
    // Given: a workload breakage observation with complete saturation evidence.
    const observation: BreakageObservation = {
      kind: "breakage",
      saturatedEndpoints: RequiredEndpoints,
      observedNonRequiredEndpoints: [],
      breakageCategory: RampBreakageCategory.Workload,
      breakageReason: "workload failed",
      evidence: { phaseResults: ["phase-1", "phase-2"] }
    }

    // When: the controller classifies the parsed observation.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      parseEvidence: parseTestEvidence,
      runIteration: async () => observation
    })

    // Then: breakage wins and the typed observation remains available unchanged.
    expect(result).toMatchObject({
      status: "failed_before_saturation",
      preserveCluster: true,
      saturatedEndpoints: RequiredEndpoints,
      missingEndpoints: []
    })
    expect(result.iterations[0]).toMatchObject({
      kind: "breakage",
      breakageCategory: RampBreakageCategory.Workload,
      observation
    })
  })

  it.each([
    ["parser null", () => null],
    [
      "parser exception",
      () => {
        throw new TypeError("parser sentinel")
      }
    ]
  ])("classifies %s as invalid observation", async (_label, parseEvidence) => {
    // Given: a generic callback root whose evidence parser cannot produce evidence.
    const observation = completedEvidenceObservation(["phase-1"])

    // When: evidence parsing returns null or throws.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      parseEvidence,
      runIteration: async () => observation
    })

    // Then: the controller returns a truthful no-observation boundary failure.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("keeps callback rejection classified as infrastructure", async () => {
    // Given: an arbitrary callback failure before any observation exists.
    const callbackError = new Error("callback failed")

    // When: the generic deferred callback rejects.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      parseEvidence: parseTestEvidence,
      runIteration: (): Promise<Observation> => Promise.reject(callbackError)
    })

    // Then: the boundary failure keeps a null observation and exact cause.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.Infrastructure,
      cause: callbackError
    })
  })

  it("retains the no-payload deferred overload", async () => {
    // Given: the pre-existing deferred callback shape has no parseEvidence option.
    const observation = {
      ...completedObservation(),
      saturatedEndpoints: RequiredEndpoints
    }

    // When: the legacy overload runs unchanged.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: compatibility behavior remains saturated and observation-backed.
    expect(result).toMatchObject({
      status: "saturated",
      preserveCluster: false
    })
    expect(result.iterations[0]).toMatchObject({ kind: "saturated" })
  })

  it("executes compile-time exact-key proofs", () => {
    // Given/When/Then: every type-level proof above resolves to true.
    expect([
      CompletedKeysProof,
      BreakageKeysProof,
      ForbiddenKeysProof,
      ObservationKindsProof,
      BreakageCategoryRequiredProof,
      BreakageReasonRequiredProof
    ]).toEqual([true, true, true, true, true, true])
  })
})
