import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  StressRampDefaults,
  runSaturationRamp,
  type StressRampConfig,
  type StressRampIterationOutcome
} from "@wireio/test-flow-swap-stress-saturation"

describe("runSaturationRamp ethereum all-legs aggregation", () => {
  it("continues after the first Ethereum endpoint and passes when the second endpoint saturates later", async () => {
    // Given: the first iteration saturates only outpost-to-depot and the second saturates depot-to-outpost.
    const evidenceDir = makeEvidenceDir("two-iteration-pass")

    // When: the ramp controller aggregates required endpoints across the campaign.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestConfig,
      runIteration: async input =>
        iterationOutcome(input.iterationIndex, input.accountCount)
    })

    // Then: the campaign succeeds only after both required Ethereum directions are present.
    expect(result.status).toBe("saturated")
    expect(result.preserveCluster).toBe(false)
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4
    ])
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "not_saturated",
      saturatedEndpoints: [
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        ]
      ],
      missingEndpoints: [
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        ]
      ]
    })
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "saturated",
      saturatedEndpoints: [
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        ],
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        ]
      ],
      missingEndpoints: []
    })
  })

  it("preserves partial Ethereum saturation when breakage happens before the second endpoint", async () => {
    // Given: one required Ethereum endpoint saturated before a later transaction breakage.
    const evidenceDir = makeEvidenceDir("breakage-after-partial")

    // When: the ramp controller sees breakage after a partial required endpoint set.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestConfig,
      runIteration: async input =>
        input.iterationIndex === 0
          ? iterationOutcome(input.iterationIndex, input.accountCount)
          : breakageOutcome(input.iterationIndex, input.accountCount)
    })

    // Then: the final status is breakage, not success, and the partial endpoint remains visible.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.saturatedEndpoints).toEqual([
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      ]
    ])
    expect(result.missingEndpoints).toEqual([
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      ]
    ])
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "failed_before_saturation",
      breakageReason: "tx reverted",
      saturatedEndpoints: [
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
        ]
      ],
      missingEndpoints: [
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        ]
      ]
    })
  })

  it("does not convert all-legs evidence on a breakage iteration into success", async () => {
    // Given: one iteration reports both required Ethereum endpoints and a payout timeout breakage.
    const evidenceDir = makeEvidenceDir("breakage-with-all-legs")

    // When: the ramp controller classifies the campaign.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestConfig,
      runIteration: async input =>
        allLegsBreakageOutcome(input.iterationIndex, input.accountCount)
    })

    // Then: payout breakage is never success, even when endpoint evidence is complete.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.saturatedEndpoints).toEqual(requiredEndpointNames())
    expect(result.missingEndpoints).toEqual([])
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "failed_before_saturation",
      breakageReason: "phase-1 payout observation failed: timeout",
      saturatedEndpoints: requiredEndpointNames(),
      missingEndpoints: []
    })
  })
})

const TestConfig: StressRampConfig = {
  initialCount: 2,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 30_000
}

function iterationOutcome(
  iterationIndex: number,
  accountCount: number
): StressRampIterationOutcome {
  const endpoint =
    iterationIndex === 0
      ? DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      : DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
  return {
    kind: "not_saturated",
    iterationIndex,
    accountCount,
    phase: `phase-${iterationIndex + 1}`,
    startedAtMs: 1_775_612_500_000 + iterationIndex,
    endedAtMs: 1_775_612_501_000 + iterationIndex,
    txSuccesses: accountCount,
    txFailures: 0,
    envelopeCount: 2,
    envelopeByteSizes: [
      StressRampDefaults.EvidenceFixtureBytes,
      StressRampDefaults.EvidenceFixtureBytes
    ],
    endpoint: DebugOutpostEndpointsType[endpoint],
    epochStart: 20 + iterationIndex,
    epochEnd: 21 + iterationIndex,
    saturatedEndpoints: [DebugOutpostEndpointsType[endpoint]],
    missingEndpoints: requiredEndpointNames().filter(
      name => name !== DebugOutpostEndpointsType[endpoint]
    ),
    observedNonRequiredEndpoints: []
  }
}

function breakageOutcome(
  iterationIndex: number,
  accountCount: number
): StressRampIterationOutcome {
  return {
    kind: "breakage",
    iterationIndex,
    accountCount,
    phase: "phase-2",
    startedAtMs: 1_775_612_500_000 + iterationIndex,
    endedAtMs: 1_775_612_501_000 + iterationIndex,
    txSuccesses: 1,
    txFailures: 1,
    breakageReason: "tx reverted",
    envelopeCount: 1,
    envelopeByteSizes: [StressRampDefaults.EvidenceFixtureBytes],
    endpoint:
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      ],
    epochStart: 22,
    epochEnd: 23,
    saturatedEndpoints: [],
    missingEndpoints: requiredEndpointNames(),
    observedNonRequiredEndpoints: []
  }
}

function allLegsBreakageOutcome(
  iterationIndex: number,
  accountCount: number
): StressRampIterationOutcome {
  return {
    kind: "breakage",
    iterationIndex,
    accountCount,
    phase: "phase-1",
    startedAtMs: 1_775_612_500_000 + iterationIndex,
    endedAtMs: 1_775_612_501_000 + iterationIndex,
    txSuccesses: accountCount,
    txFailures: 0,
    breakageReason: "phase-1 payout observation failed: timeout",
    envelopeCount: 2,
    envelopeByteSizes: [
      StressRampDefaults.EvidenceFixtureBytes,
      StressRampDefaults.EvidenceFixtureBytes
    ],
    endpoint:
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      ],
    epochStart: 22,
    epochEnd: 23,
    saturatedEndpoints: requiredEndpointNames(),
    missingEndpoints: [],
    observedNonRequiredEndpoints: []
  }
}

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}

function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `eth-all-legs-ramp-${label}-`))
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
