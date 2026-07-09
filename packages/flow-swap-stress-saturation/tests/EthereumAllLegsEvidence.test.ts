import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  StressRampDefaults,
  runSaturationRamp,
  type StressRampConfig,
  type StressRampEvidence,
  type StressRampIterationOutcome
} from "@wireio/test-flow-swap-stress-saturation"

describe("strict Ethereum all-legs evidence", () => {
  it("records partial_saturation evidence when max count is reached with one Ethereum endpoint", async () => {
    // Given: a campaign only saturates the Ethereum outpost-to-depot direction.
    const evidenceDir = makeEvidenceDir("partial")

    // When: the ramp reaches max count before the return Ethereum direction saturates.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestConfig,
      runIteration: async input =>
        partialIteration(input.iterationIndex, input.accountCount)
    })

    // Then: final evidence is visibly non-pass and names the missing Ethereum endpoint.
    expect(result.status).toBe("partial_saturation")
    expect(result.saturatedEndpoints).toEqual([
      RequiredEndpointNames.OutpostEthereumDepot
    ])
    expect(result.missingEndpoints).toEqual([
      RequiredEndpointNames.DepotOutpostEthereum
    ])
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "partial_saturation",
      saturatedEndpoints: [RequiredEndpointNames.OutpostEthereumDepot],
      missingEndpoints: [RequiredEndpointNames.DepotOutpostEthereum],
      observedNonRequiredEndpoints: []
    })
  })

  it("rejects saturated evidence that is missing a required Ethereum endpoint", () => {
    // Given: a malformed evidence object claims success with only one required endpoint.
    const evidence = {
      status: "saturated",
      saturatedEndpoints: [RequiredEndpointNames.OutpostEthereumDepot],
      missingEndpoints: [RequiredEndpointNames.DepotOutpostEthereum]
    } satisfies Pick<
      StressRampEvidence,
      "status" | "saturatedEndpoints" | "missingEndpoints"
    >

    // When/Then: the local evidence guard rejects the impossible success shape.
    expect(() => assertStrictSaturatedEvidence(evidence)).toThrow(
      /saturated evidence missing required Ethereum endpoints/
    )
  })
})

const TestConfig: StressRampConfig = {
  initialCount: 2,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 30_000
}

const RequiredEndpointNames = {
  OutpostEthereumDepot:
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
  DepotOutpostEthereum:
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
}

function partialIteration(
  iterationIndex: number,
  accountCount: number
): StressRampIterationOutcome {
  return {
    kind: "not_saturated",
    iterationIndex,
    accountCount,
    phase: "phase-1",
    startedAtMs: 1_775_612_500_000 + iterationIndex,
    endedAtMs: 1_775_612_501_000 + iterationIndex,
    txSuccesses: accountCount,
    txFailures: 0,
    envelopeCount: 2,
    envelopeByteSizes: [
      StressRampDefaults.EvidenceFixtureBytes,
      StressRampDefaults.EvidenceFixtureBytes
    ],
    endpoint: RequiredEndpointNames.OutpostEthereumDepot,
    epochStart: 20 + iterationIndex,
    epochEnd: 21 + iterationIndex,
    saturatedEndpoints: [RequiredEndpointNames.OutpostEthereumDepot],
    missingEndpoints: [RequiredEndpointNames.DepotOutpostEthereum],
    observedNonRequiredEndpoints: []
  }
}

function assertStrictSaturatedEvidence(
  evidence: Pick<
    StressRampEvidence,
    "status" | "saturatedEndpoints" | "missingEndpoints"
  >
): void {
  if (evidence.status === "saturated" && evidence.missingEndpoints.length > 0) {
    throw new Error("saturated evidence missing required Ethereum endpoints")
  }
}

function makeEvidenceDir(label: string): string {
  return Fs.mkdtempSync(
    Path.join(OS.tmpdir(), `eth-all-legs-evidence-${label}-`)
  )
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
