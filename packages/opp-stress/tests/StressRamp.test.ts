import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  runOppStressRamp,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  createSchemaRampHarness,
  schemaObservation
} from "./stressRampSchemaV1TestSupport.js"
import { expectVerifiedRampEvidence } from "./stressRampVerificationTestSupport.js"

const EndpointA = RunEvidenceEndpoint.OutpostEthereumDepot,
  EndpointB = RunEvidenceEndpoint.DepotOutpostEthereum,
  BaseConfig = {
    initialCount: 2,
    multiplier: 2,
    maxCount: 8,
    phaseTimeoutMs: 30_000
  } as const,
  TamperedArtifactBytes = Buffer.from("tampered immutable raw artifact")

describe("runOppStressRamp", () => {
  it("persists early saturation and rejects post-run artifact tamper", async () => {
    // Given: raw-backed observations saturate the required endpoint at count four.
    const harness = await createSchemaRampHarness(BaseConfig, [EndpointA])
    try {
      // When: the schema-v1 ramp reaches saturation before max.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: () => 1_000,
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [EndpointA],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: input.accountCount >= 4 ? [EndpointA] : [],
            observationStartedAtMs: 100n,
            observationEndedAtMs: 200n
          })
      })

      // Then: records and raw recomputation agree before immutable data tampering.
      expect(result.status).toBe("saturated")
      expect(
        result.iterations.map(iteration => iteration.accountCount)
      ).toEqual([2, 4])
      expect(result.iterations[1]).toMatchObject({
        status: "saturated",
        startedAtMs: 1_000,
        endedAtMs: 1_000,
        observationStartedAtMs: 100n,
        observationEndedAtMs: 200n,
        saturatedEndpoints: [EndpointA],
        missingEndpoints: []
      })
      const evidence = expectVerifiedRampEvidence(harness, {
          iterations: [
            {
              accountCount: 2,
              outcome: RunEvidenceIterationOutcome.NotSaturated,
              saturatedEndpoints: [],
              missingEndpoints: [EndpointA]
            },
            {
              accountCount: 4,
              outcome: RunEvidenceIterationOutcome.Saturated,
              saturatedEndpoints: [EndpointA],
              missingEndpoints: []
            }
          ],
          terminal: {
            lifecycle: RunEvidenceLifecycle.Saturated,
            preserveCluster: false,
            verdict: RunEvidenceVerificationVerdict.Saturated
          }
        }),
        dataPath = evidence.iterations[0]?.phases[0]?.artifactRefs[0]
      if (dataPath === undefined)
        throw new Error("referenced immutable data artifact expected")
      if (evidence.manifest.lifecycle !== RunEvidenceLifecycle.Saturated)
        throw new Error("saturated manifest expected")
      const artifact = evidence.manifest.artifacts.find(
        value => value.firstImmutableRefs.data.path === dataPath
      )
      if (artifact === undefined)
        throw new Error("manifest-owned data artifact expected")
      Fs.writeFileSync(
        Path.join(harness.persistence.runDirectory, dataPath),
        TamperedArtifactBytes
      )
      const tampered = verifyRunEvidence(harness.persistence.runDirectory)
      expect(tampered).toMatchObject({
        valid: false,
        verdict: RunEvidenceVerificationVerdict.Invalid,
        verifiedSaturated: false
      })
      expect(tampered.issues).toContainEqual(
        expect.objectContaining({
          code: RunEvidenceVerificationIssueCode.ArtifactHashMismatch,
          path: dataPath,
          detail: expect.stringContaining(
            "data digest differs from manifest ref"
          )
        })
      )
    } finally {
      harness.cleanup()
    }
  })

  it("preserves evidence when the maximum count is reached before full saturation", async () => {
    // Given: raw-backed observations never saturate the required endpoint.
    const config = { ...BaseConfig, maxCount: 4 },
      harness = await createSchemaRampHarness(config, [EndpointB])
    try {
      // When: the schema-v1 ramp reaches its maximum account count.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: () => 1_000,
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [EndpointB],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: []
          })
      })

      // Then: persisted incomplete evidence is valid non-success and preserved.
      expect(result).toMatchObject({
        status: "saturation_not_reached",
        preserveCluster: true
      })
      expect(result.iterations[1]?.preserveCluster).toBe(true)
      expectVerifiedRampEvidence(harness, {
        iterations: [2, 4].map(accountCount => ({
          accountCount,
          outcome: RunEvidenceIterationOutcome.NotSaturated,
          saturatedEndpoints: [],
          missingEndpoints: [EndpointB]
        })),
        terminal: {
          lifecycle: RunEvidenceLifecycle.Incomplete,
          preserveCluster: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess
        }
      })
    } finally {
      harness.cleanup()
    }
  })

  it("continues after an iteration saturates only part of the required OPP endpoint set", async () => {
    // Given: the first raw-backed iteration saturates only endpoint A.
    const harness = await createSchemaRampHarness(BaseConfig, [
      EndpointA,
      EndpointB
    ])
    try {
      // When: the next iteration independently saturates endpoint B.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: () => 1_000,
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [EndpointA, EndpointB],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints:
              input.iterationIndex === 0 ? [EndpointA] : [EndpointB]
          })
      })

      // Then: persisted and recomputed partitions become cumulative A plus B.
      expect(result.status).toBe("saturated")
      expect(result.iterations[0]).toMatchObject({
        status: "not_saturated",
        missingEndpoints: [EndpointB]
      })
      expectVerifiedRampEvidence(harness, {
        iterations: [
          {
            accountCount: 2,
            outcome: RunEvidenceIterationOutcome.NotSaturated,
            saturatedEndpoints: [EndpointA],
            missingEndpoints: [EndpointB]
          },
          {
            accountCount: 4,
            outcome: RunEvidenceIterationOutcome.Saturated,
            saturatedEndpoints: [EndpointA, EndpointB],
            missingEndpoints: []
          }
        ],
        terminal: {
          lifecycle: RunEvidenceLifecycle.Saturated,
          preserveCluster: false,
          verdict: RunEvidenceVerificationVerdict.Saturated
        }
      })
    } finally {
      harness.cleanup()
    }
  })

  it("preserves incomplete saturated evidence as partial saturation", async () => {
    // Given: exact-max raw evidence saturates endpoint A but not endpoint B.
    const config = { ...BaseConfig, maxCount: 2 },
      harness = await createSchemaRampHarness(config, [EndpointA, EndpointB])
    try {
      // When: the schema-v1 controller reaches max with a partial partition.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
        persistence: harness.persistence,
        clock: () => 1_000,
        runIteration: input =>
          schemaObservation({
            ...harness,
            requiredEndpoints: [EndpointA, EndpointB],
            iterationIndex: input.iterationIndex,
            accountCount: input.accountCount,
            saturatedEndpoints: [EndpointA]
          })
      })

      // Then: partial saturation is verifier-valid incomplete preserved evidence.
      expect(result).toMatchObject({
        status: "partial_saturation",
        preserveCluster: true,
        saturatedEndpoints: [EndpointA],
        missingEndpoints: [EndpointB]
      })
      expectVerifiedRampEvidence(harness, {
        iterations: [
          {
            accountCount: 2,
            outcome: RunEvidenceIterationOutcome.NotSaturated,
            saturatedEndpoints: [EndpointA],
            missingEndpoints: [EndpointB]
          }
        ],
        terminal: {
          lifecycle: RunEvidenceLifecycle.Incomplete,
          preserveCluster: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess
        }
      })
    } finally {
      harness.cleanup()
    }
  })
})
