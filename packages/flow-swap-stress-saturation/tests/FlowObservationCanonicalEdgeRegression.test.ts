import {
  createEnvelopeBaseline,
  EnvelopeIntegrityIssueCode
} from "@wireio/debugging-shared"
import type {
  EnvelopeIntegrityIssue,
  EnvelopeIntegrityResult
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy,
  projectOppEnvelopeSaturationMetrics
} from "@wireio/test-opp-stress"
import {
  phaseResult,
  projectPendingOppPhaseMetrics,
  runSaturationRamp
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  SwapStressIterationObservation,
  SwapStressPhaseResult
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"

const Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const,
  RequiredEndpoints = [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ] as const

describe("swap stress canonical parser edge regressions", () => {
  it("accepts canonical Empty health retaining a global issue", async () => {
    // Given: canonical projection retains a scan failure in Empty health without malformed records.
    const phase = pendingPhase({
      kind: "scan_failed",
      candidates: [],
      valid: [],
      pending: [],
      issues: [directoryScanIssue()]
    })
    expect(phase.health?.kind).toBe(OppEnvelopeTelemetryHealthKind.Empty)
    expect(phase.health?.issues).toHaveLength(1)
    expect(phase.malformedRecords).toEqual([])

    // When: the producer-derived phase crosses the flow parser.
    const { observation, result } = await runObservation([phase], [])

    // Then: Empty global diagnostics remain observation-backed unsaturated evidence.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.iterations[0]?.observation).toEqual(observation)
  })

  it("accepts a canonical malformed record with an empty candidate key", async () => {
    // Given: strict projection derives an empty malformed key from an empty discovered base key.
    const issue: EnvelopeIntegrityIssue = {
        code: EnvelopeIntegrityIssueCode.InvalidStorageKey,
        baseKey: "",
        context: { filename: "", reason: "noncanonical_format" }
      },
      phase = pendingPhase({
        kind: "collected",
        candidates: [""],
        valid: [],
        pending: [],
        issues: [issue]
      })
    expect(phase.health?.kind).toBe(
      OppEnvelopeTelemetryHealthKind.PendingPublication
    )
    expect(phase.malformedRecords[0]?.key).toBe("")

    // When: the producer-derived pending phase crosses the flow parser.
    const { observation, result } = await runObservation([phase], [])

    // Then: the empty record key remains valid only inside its exact issue-backed record.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.iterations[0]?.observation).toEqual(observation)
  })

  it("rejects measured saturation with zero envelopes", async () => {
    // Given: two healthy measured phases forge saturation without observed envelopes.
    const phaseResults = [
      measuredZeroPhase("phase-1", RequiredEndpoints[0], true),
      measuredZeroPhase("phase-2", RequiredEndpoints[1], true)
    ]

    // When: the forged phases attempt to authenticate both root claims.
    const { result } = await runObservation(phaseResults, RequiredEndpoints)

    // Then: the flow parser rejects the impossible saturation evidence.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("accepts healthy zero-envelope phases when unsaturated", async () => {
    // Given: legal healthy measurements report no envelopes and no saturation.
    const phaseResults = [
      measuredZeroPhase("phase-1", RequiredEndpoints[0], false),
      measuredZeroPhase("phase-2", RequiredEndpoints[1], false)
    ]

    // When: the legal zero observations cross the flow parser.
    const { observation, result } = await runObservation(phaseResults, [])

    // Then: zero-envelope evidence remains observation-backed but unsaturated.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.iterations[0]?.observation).toEqual(observation)
  })
})

function pendingPhase(result: EnvelopeIntegrityResult): SwapStressPhaseResult {
  const metrics = projectOppEnvelopeSaturationMetrics(result, {
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    epochStart: 0,
    epochEnd: 0
  })
  if (
    metrics.health.kind !== OppEnvelopeTelemetryHealthKind.Empty &&
    metrics.health.kind !== OppEnvelopeTelemetryHealthKind.PendingPublication
  )
    throw new Error("pending producer health expected")
  const baseline = createEnvelopeBaseline([]),
    projected = projectPendingOppPhaseMetrics({
      phase: "phase-1",
      endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
      strategy: RunEvidenceSaturationStrategy.Rollover,
      window: {
        startedAtMs: "1",
        endedAtMs: "2",
        epochStart: "0",
        epochEnd: "0"
      },
      saturated: false,
      solanaOversized: metrics.solanaOversized,
      envelopeCount: metrics.envelopeCount,
      envelopeByteSizes: metrics.byteSizes,
      epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
      health: metrics.health,
      malformedRecords: metrics.malformedRecords,
      selectedArtifacts: [],
      evidence: {
        kind: "not_recorded",
        baseline: { identity: baseline.identity, artifactRefs: [] }
      }
    })
  return phaseResult(
    "phase-1",
    { successes: [], failures: [] },
    null,
    projected,
    1,
    2
  )
}

function measuredZeroPhase(
  phase: "phase-1" | "phase-2",
  endpoint: RunEvidenceEndpoint,
  saturated: boolean
): SwapStressPhaseResult {
  const metrics = strictSnapshotMetrics({
    phase,
    saturated,
    envelopeCount: 0,
    envelopeByteSizes: [],
    endpoint,
    epochStart: "0",
    epochEnd: "0"
  })
  return phaseResult(
    phase,
    { successes: [], failures: [] },
    null,
    {
      ...metrics,
      health: {
        kind: OppEnvelopeTelemetryHealthKind.Healthy,
        retryable: false,
        candidateCount: 1,
        validCount: 0,
        filteredCount: 1,
        issueCount: 0,
        issues: []
      }
    },
    1,
    2
  )
}

async function runObservation(
  phaseResults: readonly SwapStressPhaseResult[],
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
) {
  const observation: SwapStressIterationObservation = {
      kind: "completed",
      saturatedEndpoints,
      observedNonRequiredEndpoints: [],
      evidence: { phaseResults, telemetryDegradation: null }
    },
    result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })
  return { observation, result }
}

function directoryScanIssue(): EnvelopeIntegrityIssue {
  return {
    code: EnvelopeIntegrityIssueCode.DirectoryScanFailed,
    baseKey: "$storage",
    context: {
      storageDir: "/cluster/data/opp-debugging",
      error: {
        name: "Error",
        code: "EIO",
        message: "scan failed",
        operation: "readdir"
      }
    }
  }
}
