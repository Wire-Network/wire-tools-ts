import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode
} from "@wireio/test-opp-stress"
import type { OppEnvelopeTelemetryIssue } from "@wireio/test-opp-stress"
import type {
  RealMetricPollingRuntime,
  SwapStressEnvelopeMetricRequest,
  SwapStressPendingPhaseObservation
} from "@wireio/test-flow-swap-stress-saturation"

import {
  measuredCollection,
  pendingObservation
} from "./phaseRunnerTelemetryTestSupport.js"
import { producePollableIntegrityIssues } from "./realMetricPollingIssueFixtures.js"

type NonHealthyCase = {
  readonly name: string
  readonly observation: SwapStressPendingPhaseObservation
}
type StrictSnapshotResult = Awaited<
  ReturnType<RealMetricPollingRuntime["collect"]>
>

const baseline = createEnvelopeBaseline(["existing"])

/** Canonical request whose baseline identity must survive every retry. */
export const PollingRequest: SwapStressEnvelopeMetricRequest = {
  phase: "phase-1",
  startedAtMs: 10,
  endedAtMs: 20,
  endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
  baseline
}

const healthyCollection = measuredCollection(PollingRequest, false)
if (healthyCollection.kind !== "measured") {
  throw new TypeError(
    "measured collection fixture returned a nonhealthy result"
  )
}

/** Healthy result used to repair a nonhealthy strict snapshot. */
export const HealthyCollection = healthyCollection

/**
 * Build every nonhealthy polling case from strict-reader producer output.
 * @returns Empty, twenty-four exact issues, and partial-valid-plus-invalid.
 */
export async function createNonHealthyCases(): Promise<
  readonly NonHealthyCase[]
> {
  const fixtures = await producePollableIntegrityIssues(),
    partial = fixtures.find(
      fixture =>
        fixture.issue.code === OppEnvelopeTelemetryIssueCode.DataHashMismatch
    )
  if (partial === undefined)
    throw new TypeError("partial issue fixture missing")
  return [
    { name: "empty", observation: emptyObservation() },
    ...fixtures.map(fixture => ({
      name: fixture.name,
      observation:
        fixture.scope === "candidate"
          ? pendingWithIssue(fixture.issue)
          : emptyObservation(fixture.issue)
    })),
    {
      name: "partial-valid-plus-invalid",
      observation: pendingWithIssue(partial.issue, 2, 1)
    }
  ]
}

/** Deterministic fake runtime recording every collection timestamp and wait. */
export function createFakePollingRuntime(
  results: readonly StrictSnapshotResult[]
): RealMetricPollingRuntime & {
  readonly attemptedAtMs: number[]
  readonly waitsMs: number[]
  readonly requests: SwapStressEnvelopeMetricRequest[]
  readonly returnedResults: StrictSnapshotResult[]
} {
  let nowMs = 0,
    index = 0
  const attemptedAtMs: number[] = [],
    waitsMs: number[] = [],
    requests: SwapStressEnvelopeMetricRequest[] = [],
    returnedResults: StrictSnapshotResult[] = []
  return {
    attemptedAtMs,
    waitsMs,
    requests,
    returnedResults,
    now: () => nowMs,
    wait: async milliseconds => {
      waitsMs.push(milliseconds)
      nowMs += milliseconds
    },
    collect: async request => {
      attemptedAtMs.push(nowMs)
      requests.push(request)
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      if (result === undefined) throw new Error("fake collector has no result")
      returnedResults.push(result)
      return result
    }
  }
}

function pendingWithIssue(
  issue: OppEnvelopeTelemetryIssue,
  candidateCount = 1,
  validCount = 0
): SwapStressPendingPhaseObservation {
  const base = pendingObservation(baseline)
  return {
    ...base,
    health: {
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount,
      validCount,
      filteredCount: 0,
      issueCount: 1,
      issues: [issue]
    },
    malformedRecords: [{ key: issue.baseKey, reason: issue.code, issue }]
  }
}

function emptyObservation(
  issue: OppEnvelopeTelemetryIssue | null = null
): SwapStressPendingPhaseObservation {
  const base = pendingObservation(baseline)
  return {
    ...base,
    health: {
      kind: OppEnvelopeTelemetryHealthKind.Empty,
      retryable: true,
      candidateCount: 0,
      validCount: 0,
      filteredCount: 0,
      issueCount: issue === null ? 0 : 1,
      issues: issue === null ? [] : [issue]
    },
    malformedRecords: []
  }
}
