import {
  OppEnvelopeTelemetryHealthKind,
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePhaseStatus,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  runOppStressRamp,
  verifyRunEvidence,
  type OppStressRampCompletedObservation
} from "@wireio/test-opp-stress"

import {
  createSchemaRampHarness,
  schemaObservation
} from "./stressRampSchemaV1TestSupport.js"
import {
  expectRampEvidenceLayout,
  readRampEvidence
} from "./stressRampVerificationTestSupport.js"

const EndpointA = RunEvidenceEndpoint.OutpostEthereumDepot,
  Config = {
    initialCount: 2,
    multiplier: 2,
    maxCount: 4,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp evidence integrity", () => {
  it("rejects schema-valid forged saturation against healthy small raw bytes", async () => {
    // Given: an unsaturated artifact-backed observation is copied into coherent fake claims.
    const harness = await createSchemaRampHarness(Config, [EndpointA])
    try {
      // When: the controller persists the parser-valid forged saturation.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: () => 1_000,
        runIteration: async input => {
          const observation = await schemaObservation({
            ...harness,
            requiredEndpoints: [EndpointA],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: []
          })
          if (observation.kind !== "completed")
            throw new Error("completed observation expected")
          return forgeSaturatedObservation(observation)
        }
      })

      // Then: public parsers accept canonical records but raw recomputation rejects them.
      expect(result).toMatchObject({
        status: "saturated",
        preserveCluster: false,
        saturatedEndpoints: [EndpointA],
        missingEndpoints: []
      })
      const evidence = readRampEvidence(harness.persistence.runDirectory)
      expectRampEvidenceLayout(harness, evidence)
      expect(evidence.iterations[0]).toMatchObject({
        outcome: RunEvidenceIterationOutcome.Saturated,
        saturatedEndpoints: [EndpointA],
        missingEndpoints: [],
        phases: [
          {
            status: RunEvidencePhaseStatus.Completed,
            telemetry: { kind: OppEnvelopeTelemetryHealthKind.Healthy },
            metrics: {
              envelopeCount: 1,
              epochEnvelopeIndexes: [0],
              saturated: true
            }
          }
        ]
      })
      expect(evidence.terminal.lifecycle).toBe(RunEvidenceLifecycle.Saturated)
      expect(evidence.manifest.lifecycle).toBe(RunEvidenceLifecycle.Saturated)
      const report = verifyRunEvidence(harness.persistence.runDirectory),
        issueCodes = report.issues.map(issue => issue.code)
      expect(report).toMatchObject({
        valid: false,
        verdict: RunEvidenceVerificationVerdict.Invalid,
        verifiedSaturated: false
      })
      expect(issueCodes).toEqual(
        expect.arrayContaining([
          RunEvidenceVerificationIssueCode.MetricMismatch,
          RunEvidenceVerificationIssueCode.IterationMismatch,
          RunEvidenceVerificationIssueCode.ManifestMismatch,
          RunEvidenceVerificationIssueCode.TerminalMismatch,
          RunEvidenceVerificationIssueCode.LifecycleMismatch
        ])
      )
      expect(issueCodes).not.toContain(
        RunEvidenceVerificationIssueCode.HashMismatch
      )
      expect(issueCodes).not.toContain(
        RunEvidenceVerificationIssueCode.ArtifactHashMismatch
      )
      expect(report.recomputedIterations).toEqual([
        expect.objectContaining({
          iterationIndex: 0,
          accountCount: 2,
          saturatedEndpoints: [],
          missingEndpoints: [EndpointA],
          phases: [
            expect.objectContaining({
              envelopeCount: 1,
              epochEnvelopeIndexes: [0],
              saturated: false
            })
          ]
        })
      ])
      expect(report.recomputedEndpoints).toEqual([
        {
          endpoint: EndpointA,
          saturated: false,
          supportingPhases: []
        }
      ])
    } finally {
      harness.cleanup()
    }
  })
})

function forgeSaturatedObservation(
  observation: OppStressRampCompletedObservation
): OppStressRampCompletedObservation {
  const phase = observation.phases[0]
  if (phase?.status !== RunEvidencePhaseStatus.Completed)
    throw new Error("completed phase expected")
  return {
    ...observation,
    saturatedEndpoints: [EndpointA],
    phases: [
      {
        ...phase,
        metrics: { ...phase.metrics, saturated: true }
      }
    ]
  }
}
