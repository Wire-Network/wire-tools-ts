import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
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
  controllerClock,
  readSchemaRampRecords
} from "./stressRampSchemaV1PersistenceTestSupport.js"

describe("runOppStressRamp schema-v1 failure persistence", () => {
  it("publishes callback rejection as canonical failed evidence", async () => {
    // Given: a fresh active persistence and a callback error.
    const harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
        SchemaV1EndpointA
      ]),
      callbackError = new Error("callback failed"),
      clock = jest.fn().mockReturnValueOnce(103).mockReturnValueOnce(104)
    try {
      // When: the callback rejects before an observation resolves.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock,
        runIteration: () => Promise.reject(callbackError)
      })
      // Then: callback ownership completes both checkpoints before returning.
      expect(clock).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({
        status: "failed_before_saturation",
        preserveCluster: true,
        saturatedEndpoints: [],
        missingEndpoints: [SchemaV1EndpointA]
      })
      expect(result.iterations[0]).toMatchObject({
        kind: "breakage",
        observation: null,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "callback failed",
        cause: callbackError
      })
      const records = readSchemaRampRecords(harness.persistence.runDirectory, 0)
      expect(records.iteration).toMatchObject({
        outcome: RunEvidenceIterationOutcome.Breakage,
        startedAtMs: "103",
        endedAtMs: "104",
        phases: [],
        saturatedEndpoints: [],
        missingEndpoints: [SchemaV1EndpointA],
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "callback failed"
      })
      expect(records.iteration.endpointResults).toEqual([
        {
          endpoint: SchemaV1EndpointA,
          saturated: false,
          telemetry: {
            kind: "empty",
            retryable: true,
            candidateCount: 0,
            validCount: 0,
            filteredCount: 0,
            issueCount: 0,
            issues: []
          }
        }
      ])
      expect(records.iteration.telemetry).toEqual(
        records.iteration.endpointResults[0]?.telemetry
      )
      expect(records.terminal).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        endedAtMs: "104",
        preserveCluster: true,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "callback failed"
      })
      expect(records.terminal.iterationRefs).toEqual(
        records.manifest.records.iterations
      )
      expect(records.manifest).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        preserveCluster: true
      })
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess,
        verifiedSaturated: false
      })
      expect(
        Fs.readdirSync(harness.persistence.runDirectory, {
          recursive: true
        }).some(file => String(file).endsWith(".tmp"))
      ).toBe(false)
      expect(records.legacyIterationExists).toBe(false)
    } finally {
      harness.cleanup()
    }
  })

  it("rejects nested rich accessors without evaluating them", async () => {
    // Given: endpoint telemetry is replaced by a stateful nested accessor.
    const harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
        SchemaV1EndpointA
      ]),
      clock = controllerClock()
    let getterCalls = 0
    try {
      // When: the rich observation crosses the recursive descriptor snapshot.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock,
        runIteration: async input => {
          const observation = await schemaObservation({
              ...harness,
              requiredEndpoints: [SchemaV1EndpointA],
              iterationIndex: input.iterationIndex,
              accountCount: input.accountCount,
              saturatedEndpoints: [SchemaV1EndpointA]
            }),
            endpointTelemetry = observation.endpointTelemetry[0]
          if (endpointTelemetry === undefined)
            throw new Error("endpoint telemetry expected")
          Object.defineProperty(endpointTelemetry, "telemetry", {
            enumerable: true,
            get: () => {
              getterCalls += 1
              return observation.telemetry
            }
          })
          return observation
        }
      })
      // Then: parsing publishes invalid-observation evidence without running arbitrary code.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(result.iterations[0]).not.toHaveProperty("phase")
      expect(result.iterations[0]).not.toHaveProperty("txSuccesses")
      expect(result.iterations[0]).not.toHaveProperty("endpoint")
      expect(getterCalls).toBe(0)
      expect(
        Fs.readdirSync(
          Path.join(
            harness.persistence.runDirectory,
            RunEvidencePath.Iterations
          )
        )
      ).toEqual(["000000.json"])
      expect(
        Fs.existsSync(
          Path.join(harness.persistence.runDirectory, RunEvidencePath.Terminal)
        )
      ).toBe(true)
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess
      })
    } finally {
      harness.cleanup()
    }
  })
})
