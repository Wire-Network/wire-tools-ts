import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  StressRampDefaults,
  runSaturationRamp
} from "@wireio/test-flow-swap-stress-saturation"

import { RampFixtures } from "./constants.js"

describe("runSaturationRamp", () => {
  it("doubles until the first saturated iteration and writes JSON evidence", async () => {
    // Given: synthetic metrics saturate at account count 16.
    const evidenceDir = makeEvidenceDir("saturated")

    // When: the ramp controller runs to saturation.
    const result = await runSaturationRamp({
      evidenceDir,
      config: RampFixtures.Config,
      runIteration: async ({ accountCount, iterationIndex }) => ({
        kind:
          accountCount === RampFixtures.SaturatingCount
            ? "saturated"
            : "not_saturated",
        iterationIndex,
        accountCount,
        phase: "phase-a",
        startedAtMs: RampFixtures.StartedAtMs + iterationIndex,
        endedAtMs: RampFixtures.EndedAtMs + iterationIndex,
        txSuccesses: accountCount,
        txFailures: 0,
        envelopeCount: accountCount === RampFixtures.SaturatingCount ? 2 : 1,
        envelopeByteSizes: [StressRampDefaults.EvidenceFixtureBytes],
        endpoint: RampFixtures.Endpoint,
        epochStart: RampFixtures.EpochStart,
        epochEnd: RampFixtures.EpochEnd,
        saturatedEndpoints:
          accountCount === RampFixtures.SaturatingCount
            ? requiredEndpointNames()
            : [],
        missingEndpoints:
          accountCount === RampFixtures.SaturatingCount
            ? []
            : requiredEndpointNames(),
        observedNonRequiredEndpoints: []
      })
    })

    // Then: the ramp stops at the first saturated count and records evidence.
    expect(result.status).toBe("saturated")
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4, 8, 16
    ])
    expect(readEvidence(evidenceDir, 3).status).toBe("saturated")
    expect(result.preserveCluster).toBe(false)
  })

  it("stops on breakage before saturation and preserves cluster metadata", async () => {
    // Given: synthetic tx failure appears before saturation.
    const evidenceDir = makeEvidenceDir("breakage")

    // When: the ramp sees breakage.
    const result = await runSaturationRamp({
      evidenceDir,
      config: RampFixtures.Config,
      runIteration: async ({ accountCount, iterationIndex }) => ({
        kind:
          accountCount === RampFixtures.BreakageCount
            ? "breakage"
            : "not_saturated",
        iterationIndex,
        accountCount,
        phase: "phase-b",
        startedAtMs: RampFixtures.StartedAtMs,
        endedAtMs: RampFixtures.EndedAtMs,
        txSuccesses: 1,
        txFailures: accountCount === RampFixtures.BreakageCount ? 1 : 0,
        breakageReason:
          accountCount === RampFixtures.BreakageCount ? "tx reverted" : null,
        envelopeCount: 1,
        envelopeByteSizes: [StressRampDefaults.EvidenceFixtureBytes],
        endpoint: RampFixtures.Endpoint,
        epochStart: RampFixtures.EpochStart,
        epochEnd: RampFixtures.EpochEnd
      })
    })

    // Then: breakage is classified and evidence asks the caller to preserve the cluster.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(readEvidence(evidenceDir, 1).preserveCluster).toBe(true)
  })

  it("does not pass a saturated outcome that is still missing a required Ethereum endpoint", async () => {
    // Given: a runner reports saturation but only one required Ethereum endpoint is present.
    const evidenceDir = makeEvidenceDir("synthetic-missing-endpoint")

    // When: the ramp controller applies campaign-level all-legs aggregation.
    const result = await runSaturationRamp({
      evidenceDir,
      config: RampFixtures.Config,
      runIteration: async ({ accountCount, iterationIndex }) => ({
        kind: "saturated",
        iterationIndex,
        accountCount,
        phase: "phase-a",
        startedAtMs: RampFixtures.StartedAtMs,
        endedAtMs: RampFixtures.EndedAtMs,
        txSuccesses: accountCount,
        txFailures: 0,
        envelopeCount: 1,
        envelopeByteSizes: [StressRampDefaults.EvidenceFixtureBytes],
        endpoint: RampFixtures.Endpoint,
        epochStart: RampFixtures.EpochStart,
        epochEnd: RampFixtures.EpochEnd,
        saturatedEndpoints: [requiredEndpointNames()[0]],
        missingEndpoints: [requiredEndpointNames()[1]],
        observedNonRequiredEndpoints: []
      })
    })

    // Then: a mislabeled iteration cannot bypass the strict both-directions rule.
    expect(result.status).toBe("partial_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "partial_saturation",
      preserveCluster: true,
      missingEndpoints: [requiredEndpointNames()[1]]
    })
  })

  it("preserves max-count evidence when no required Ethereum endpoint saturates", async () => {
    // Given: the ramp reaches the configured max count without required endpoint saturation.
    const evidenceDir = makeEvidenceDir("max-unsaturated")

    // When: the controller stops at the safety cap.
    const result = await runSaturationRamp({
      evidenceDir,
      config: {
        initialCount: 2,
        multiplier: 2,
        maxCount: 2,
        phaseTimeoutMs: 30_000
      },
      runIteration: async ({ accountCount, iterationIndex }) => ({
        kind: "not_saturated",
        iterationIndex,
        accountCount,
        phase: "phase-a",
        startedAtMs: RampFixtures.StartedAtMs,
        endedAtMs: RampFixtures.EndedAtMs,
        txSuccesses: accountCount,
        txFailures: 0,
        envelopeCount: 1,
        envelopeByteSizes: [StressRampDefaults.EvidenceFixtureBytes],
        endpoint: RampFixtures.Endpoint,
        epochStart: RampFixtures.EpochStart,
        epochEnd: RampFixtures.EpochEnd,
        saturatedEndpoints: [],
        missingEndpoints: requiredEndpointNames(),
        observedNonRequiredEndpoints: []
      })
    })

    // Then: both the final result and persisted evidence ask callers to keep artifacts.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.preserveCluster).toBe(true)
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "saturation_not_reached",
      preserveCluster: true
    })
  })
})

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}

function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `swap-stress-ramp-${label}-`))
}

function readEvidence(
  evidenceDir: string,
  iterationIndex: number
): Record<string, unknown> {
  return JSON.parse(
    Fs.readFileSync(
      Path.join(evidenceDir, `iteration-${iterationIndex}.json`),
      "utf-8"
    )
  )
}
