import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { runOppStressRamp } from "@wireio/test-opp-stress"

describe("runOppStressRamp", () => {
  it("ramps until required OPP endpoints saturate and writes bigint-safe evidence", async () => {
    // Given: a synthetic iteration runner saturates the required endpoint at count four.
    const evidenceDir = makeEvidenceDir("saturated")

    // When: the ramp executes.
    const result = await runOppStressRamp({
      evidenceDir,
      config: {
        initialCount: 2,
        multiplier: 2,
        maxCount: 8,
        phaseTimeoutMs: 30_000
      },
      requiredEndpoints: ["OUTPOST_ETHEREUM_DEPOT"],
      runIteration: async input => ({
        kind: "not_saturated",
        iterationIndex: input.iterationIndex,
        accountCount: input.accountCount,
        phase: "phase-a",
        startedAtMs: 100n,
        endedAtMs: 200n,
        txSuccesses: input.accountCount,
        txFailures: 0,
        envelopeCount: input.accountCount >= 4 ? 2 : 1,
        envelopeByteSizes: [128],
        endpoint: "OUTPOST_ETHEREUM_DEPOT",
        epochStart: 1,
        epochEnd: 1,
        saturatedEndpoints:
          input.accountCount >= 4 ? ["OUTPOST_ETHEREUM_DEPOT"] : []
      })
    })

    // Then: campaign saturation stops the ramp and serializes bigint timestamps.
    expect(result.status).toBe("saturated")
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4
    ])
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "saturated",
      startedAtMs: "100",
      endedAtMs: "200",
      saturatedEndpoints: ["OUTPOST_ETHEREUM_DEPOT"],
      missingEndpoints: []
    })
  })

  it("preserves evidence when the maximum count is reached before full saturation", async () => {
    // Given: a synthetic iteration runner never saturates the required endpoint.
    const evidenceDir = makeEvidenceDir("max")

    // When: the ramp reaches its max count.
    const result = await runOppStressRamp({
      evidenceDir,
      config: {
        initialCount: 2,
        multiplier: 2,
        maxCount: 4,
        phaseTimeoutMs: 30_000
      },
      requiredEndpoints: ["DEPOT_OUTPOST_ETHEREUM"],
      runIteration: async input => ({
        kind: "not_saturated",
        iterationIndex: input.iterationIndex,
        accountCount: input.accountCount,
        phase: "phase-b",
        startedAtMs: 300,
        endedAtMs: 400,
        txSuccesses: input.accountCount,
        txFailures: 0,
        envelopeCount: 1,
        envelopeByteSizes: [64],
        endpoint: "DEPOT_OUTPOST_ETHEREUM",
        epochStart: 2,
        epochEnd: 2
      })
    })

    // Then: the final status requests artifact preservation.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.preserveCluster).toBe(true)
    expect(readEvidence(evidenceDir, 1).preserveCluster).toBe(true)
  })

  it("continues after an iteration saturates only part of the required OPP endpoint set", async () => {
    // Given: the first iteration reports saturation for only one required endpoint.
    const evidenceDir = makeEvidenceDir("partial-then-full")

    // When: a later iteration saturates the remaining required endpoint.
    const result = await runOppStressRamp({
      evidenceDir,
      config: {
        initialCount: 2,
        multiplier: 2,
        maxCount: 8,
        phaseTimeoutMs: 30_000
      },
      requiredEndpoints: ["OUTPOST_ETHEREUM_DEPOT", "DEPOT_OUTPOST_ETHEREUM"],
      runIteration: async input => ({
        kind: "saturated",
        iterationIndex: input.iterationIndex,
        accountCount: input.accountCount,
        phase: "phase-c",
        startedAtMs: 500,
        endedAtMs: 600,
        txSuccesses: input.accountCount,
        txFailures: 0,
        envelopeCount: 2,
        envelopeByteSizes: [128, 256],
        endpoint:
          input.iterationIndex === 0
            ? "OUTPOST_ETHEREUM_DEPOT"
            : "DEPOT_OUTPOST_ETHEREUM",
        epochStart: 3,
        epochEnd: 3,
        saturatedEndpoints:
          input.iterationIndex === 0
            ? ["OUTPOST_ETHEREUM_DEPOT"]
            : ["DEPOT_OUTPOST_ETHEREUM"]
      })
    })

    // Then: the campaign does not report final saturation until both endpoints are present.
    expect(result.status).toBe("saturated")
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4
    ])
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "not_saturated",
      missingEndpoints: ["DEPOT_OUTPOST_ETHEREUM"]
    })
  })
})

function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `opp-stress-ramp-${label}-`))
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
