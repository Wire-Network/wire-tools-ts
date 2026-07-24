import {
  OppStressRampEvidenceModeKind,
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

describe("runOppStressRamp schema-v1 persistence", () => {
  it("publishes clean saturation before max with no root flat file", async () => {
    // Given: a real active run whose first generated phase saturates its endpoint.
    const harness = await createSchemaRampHarness(SchemaV1BaseConfig, [
      SchemaV1EndpointA
    ])
    try {
      // When: the schema-v1 ramp resolves before max.
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
            saturatedEndpoints: [SchemaV1EndpointA]
          })
      })
      // Then: result and every persisted layer agree on clean saturation.
      expect(result).toMatchObject({
        status: "saturated",
        preserveCluster: false,
        saturatedEndpoints: [SchemaV1EndpointA],
        missingEndpoints: []
      })
      const records = readSchemaRampRecords(harness.persistence.runDirectory, 0)
      expect(records.iteration.outcome).toBe(
        RunEvidenceIterationOutcome.Saturated
      )
      expect(records.terminal.lifecycle).toBe(RunEvidenceLifecycle.Saturated)
      expect(records.terminal.preserveCluster).toBe(false)
      expect(records.terminal.startedAtMs).toBe("100")
      expect(records.manifest.lifecycle).toBe(RunEvidenceLifecycle.Saturated)
      expect(records.manifest.preserveCluster).toBe(false)
      expect(records.legacyIterationExists).toBe(false)
      expect(records.legacyEvidenceRootIterationExists).toBe(false)
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.Saturated,
        verifiedSaturated: true
      })
    } finally {
      harness.cleanup()
    }
  })

  it("lets exact-max saturation override incomplete preservation", async () => {
    // Given: allocation begins exactly at max and the generated phase saturates.
    const config = { ...SchemaV1BaseConfig, initialCount: 2, maxCount: 2 },
      harness = await createSchemaRampHarness(config, [SchemaV1EndpointA])
    try {
      // When: the exact-max callback completes with saturation.
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
            saturatedEndpoints: [SchemaV1EndpointA]
          })
      })
      // Then: max never overrides the canonical saturation decision.
      const records = readSchemaRampRecords(harness.persistence.runDirectory, 0)
      expect(result).toMatchObject({
        status: "saturated",
        preserveCluster: false
      })
      expect(records.iteration.outcome).toBe(
        RunEvidenceIterationOutcome.Saturated
      )
      expect(records.terminal).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Saturated,
        preserveCluster: false
      })
      expect(records.manifest).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Saturated,
        preserveCluster: false
      })
      expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.Saturated,
        verifiedSaturated: true
      })
    } finally {
      harness.cleanup()
    }
  })

  it.each([
    ["partial_saturation", [SchemaV1EndpointA] as const],
    ["saturation_not_reached", [] as const]
  ])(
    "publishes incomplete max outcome %s",
    async (status, saturatedEndpoints) => {
      // Given: an exact-max run has partial or zero generated saturation.
      const config = { ...SchemaV1BaseConfig, initialCount: 2, maxCount: 2 },
        harness = await createSchemaRampHarness(config, [
          SchemaV1EndpointA,
          SchemaV1EndpointB
        ])
      try {
        // When: the controller reaches max without complete saturation.
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
              saturatedEndpoints
            })
        })
        // Then: both variants preserve an incomplete lifecycle but retain status detail.
        const records = readSchemaRampRecords(
          harness.persistence.runDirectory,
          0
        )
        expect(result).toMatchObject({ status, preserveCluster: true })
        expect(records.iteration.outcome).toBe(
          RunEvidenceIterationOutcome.NotSaturated
        )
        expect(records.terminal).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Incomplete,
          preserveCluster: true
        })
        expect(records.manifest.lifecycle).toBe(
          RunEvidenceLifecycle.Incomplete
        )
        expect(verifyRunEvidence(harness.persistence.runDirectory)).toMatchObject(
          {
            valid: true,
            verdict: RunEvidenceVerificationVerdict.NonSuccess,
            verifiedSaturated: false
          }
        )
      } finally {
        harness.cleanup()
      }
    }
  )
})
