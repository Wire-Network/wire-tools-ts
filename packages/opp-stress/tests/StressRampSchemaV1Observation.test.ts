import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceVerificationVerdict,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  createSchemaRampHarness,
  schemaObservation
} from "./stressRampSchemaV1TestSupport.js"
import {
  SchemaV1BaseConfig,
  SchemaV1EndpointA,
  SchemaV1EndpointB,
  controllerClock,
  readSchemaRampRecords
} from "./stressRampSchemaV1PersistenceTestSupport.js"

describe("runOppStressRamp schema-v1 observation persistence", () => {
  it("persists fully saturated explicit breakage as failed non-success", async () => {
    // Given: every generated completed phase saturates before workload breakage wins.
    const harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
      SchemaV1EndpointA,
      SchemaV1EndpointB
    ])
    try {
      // When: a rich breakage observation reports all current saturation.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: controllerClock(),
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [SchemaV1EndpointA, SchemaV1EndpointB],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: [SchemaV1EndpointA, SchemaV1EndpointB],
            breakage: {
              category: RampBreakageCategory.Workload,
              reason: "workload failed after saturation"
            }
          })
      })
      // Then: failure wins without discarding independently proven saturation.
      const records = readSchemaRampRecords(harness.persistence.runDirectory, 0),
        report = verifyRunEvidence(harness.persistence.runDirectory)
      expect(result).toMatchObject({
        status: "failed_before_saturation",
        preserveCluster: true,
        saturatedEndpoints: [SchemaV1EndpointA, SchemaV1EndpointB],
        missingEndpoints: []
      })
      expect(records.iteration.outcome).toBe(
        RunEvidenceIterationOutcome.Breakage
      )
      expect(records.terminal.lifecycle).toBe(RunEvidenceLifecycle.Failed)
      expect(records.manifest.lifecycle).toBe(RunEvidenceLifecycle.Failed)
      expect(report).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess,
        verifiedSaturated: false
      })
      expect(
        report.recomputedEndpoints.every(endpoint => endpoint.saturated)
      ).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it("persists and verifies cumulative saturation across iterations", async () => {
    // Given: each generated iteration saturates a different required endpoint.
    const harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
      SchemaV1EndpointA,
      SchemaV1EndpointB
    ])
    try {
      // When: cumulative saturation completes on the second iteration.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: controllerClock(),
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [SchemaV1EndpointA, SchemaV1EndpointB],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints:
              input.iterationIndex === 0
                ? [SchemaV1EndpointA]
                : [SchemaV1EndpointB]
          })
      })
      // Then: the second record and verifier report required-order cumulative arrays.
      const second = readSchemaRampRecords(
          harness.persistence.runDirectory,
          1
        ).iteration,
        report = verifyRunEvidence(harness.persistence.runDirectory)
      expect(result.status).toBe("saturated")
      expect(second.saturatedEndpoints).toEqual([
        SchemaV1EndpointA,
        SchemaV1EndpointB
      ])
      expect(second.missingEndpoints).toEqual([])
      expect(second.endpointResults[0]?.telemetry.validCount).toBe(2)
      expect(report.valid).toBe(true)
      expect(
        report.recomputedIterations.map(value => value.saturatedEndpoints)
      ).toEqual([
        [SchemaV1EndpointA],
        [SchemaV1EndpointA, SchemaV1EndpointB]
      ])
    } finally {
      harness.cleanup()
    }
  })

  it("retains exact bigint observation decimals in schema phases", async () => {
    // Given: phase and compatibility observation timestamps exceed safe-number range.
    const exactStart = "900719925474099312345",
      exactEnd = "900719925474099312346",
      harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
        SchemaV1EndpointA
      ])
    try {
      // When: the rich callback crosses the exact snapshot boundary.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: controllerClock(),
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [SchemaV1EndpointA],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: [SchemaV1EndpointA],
            observationStartedAtMs: BigInt(exactStart),
            observationEndedAtMs: BigInt(exactEnd),
            phaseStartedAtMs: exactStart,
            phaseEndedAtMs: exactEnd
          })
      })
      // Then: no Number conversion alters the persisted phase window.
      const iteration = readSchemaRampRecords(
        harness.persistence.runDirectory,
        0
      ).iteration
      expect(iteration.phases[0]?.window).toMatchObject({
        startedAtMs: exactStart,
        endedAtMs: exactEnd
      })
      expect(result.iterations[0]).toMatchObject({
        observationStartedAtMs: BigInt(exactStart),
        observationEndedAtMs: BigInt(exactEnd)
      })
    } finally {
      harness.cleanup()
    }
  })
})
