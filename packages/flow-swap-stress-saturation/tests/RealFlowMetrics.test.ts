import {
  OppEnvelopeTelemetryIssueCode
} from "@wireio/test-opp-stress"
import {
  pollRealFlowMetrics,
  RealFlowMetricPolling,
  SwapStressTelemetryDegradedError
} from "@wireio/test-flow-swap-stress-saturation"

import {
  createFakePollingRuntime,
  createNonHealthyCases,
  HealthyCollection,
  PollingRequest
} from "./realMetricPollingTestSupport.js"
import {
  NonPollableIntegrityIssueCodes,
  producePollableIntegrityIssues
} from "./realMetricPollingIssueFixtures.js"

const LastPreDeadlinePollMs = 237_000,
  ExpectedPersistentCallCount = 80,
  PollingCaseNames = [
    "empty",
    ...Object.values(OppEnvelopeTelemetryIssueCode).filter(
      code => code !== OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed
    ),
    "partial-valid-plus-invalid"
  ]

let nonHealthyCasesPromise: ReturnType<typeof createNonHealthyCases> | null = null

describe("real flow metric polling", () => {
  it("accounts for every canonical strict issue code", async () => {
    // Given: producer issue codes are partitioned by polling reachability.
    const pollable = await producePollableIntegrityIssues()
    const accounted = [
      ...pollable.map(fixture => fixture.issue.code),
      ...NonPollableIntegrityIssueCodes
    ]

    // When/Then: every code appears exactly once in that partition.
    expect(accounted.sort()).toEqual(
      Object.values(OppEnvelopeTelemetryIssueCode).sort()
    )
    expect(new Set(accounted).size).toBe(accounted.length)
  })

  it.each(PollingCaseNames)(
    "repairs producer-backed %s at the last pre-deadline poll",
    async name => {
      const { observation } = await nonHealthyCase(name)
      // Given: one strict nonhealthy class persists through 237 seconds.
      const pending = { kind: "pending" as const, observation },
        runtime = createFakePollingRuntime([
          ...Array(ExpectedPersistentCallCount - 1).fill(pending),
          HealthyCollection
        ])

      // When: the final legal poll repairs the strict snapshot.
      const result = await pollRealFlowMetrics(PollingRequest, runtime)

      // Then: repair wins without typed terminal degradation or deadline wait.
      expect(result).toBe(HealthyCollection)
      expect(runtime.attemptedAtMs).toHaveLength(ExpectedPersistentCallCount)
      expect(runtime.attemptedAtMs[0]).toBe(0)
      expect(runtime.attemptedAtMs.at(-1)).toBe(LastPreDeadlinePollMs)
      expect(runtime.waitsMs).toEqual(
        Array(ExpectedPersistentCallCount - 1).fill(
          RealFlowMetricPolling.LongPollIntervalMs
        )
      )
      expect(runtime.requests.every(request => request === PollingRequest)).toBe(
        true
      )
      expect(
        runtime.returnedResults
          .slice(0, ExpectedPersistentCallCount - 1)
          .every(snapshot => snapshot === pending)
      ).toBe(true)
      expect(
        runtime.requests.every(
          request => request.baseline === PollingRequest.baseline
        )
      ).toBe(true)
    }
  )

  it.each(PollingCaseNames)(
    "terminalizes persistent producer-backed %s at the deadline",
    async name => {
      const { observation } = await nonHealthyCase(name)
      // Given: the same immutable nonhealthy observation never repairs.
      const pending = { kind: "pending" as const, observation },
        runtime = createFakePollingRuntime([pending])

      // When: real polling exhausts the fixed deadline.
      const result = await pollRealFlowMetrics(PollingRequest, runtime)

      // Then: no deadline scan occurs and exact final evidence is retained.
      expect(result.kind).toBe("degraded")
      if (result.kind !== "degraded") throw new Error("expected degradation")
      expect(result.error).toBeInstanceOf(SwapStressTelemetryDegradedError)
      expect(result.error.degradation).toEqual({
        kind: "deadline_exhausted",
        observation
      })
      expect(result.error.degradation.observation).toBe(observation)
      expect(result.error.degradation.observation.health).toBe(observation.health)
      expect(result.error.degradation.observation.health.issues[0]).toBe(
        observation.health.issues[0]
      )
      expect(runtime.attemptedAtMs).toEqual(
        Array.from(
          { length: ExpectedPersistentCallCount },
          (_, index) => index * RealFlowMetricPolling.LongPollIntervalMs
        )
      )
      expect(runtime.waitsMs).toEqual(
        Array(ExpectedPersistentCallCount).fill(
          RealFlowMetricPolling.LongPollIntervalMs
        )
      )
      expect(runtime.waitsMs.reduce((total, wait) => total + wait, 0)).toBe(
        RealFlowMetricPolling.RelayDeadlineMs
      )
    }
  )

  it("returns first-poll healthy evidence without waiting", async () => {
    // Given: the immediate strict snapshot is already healthy.
    const runtime = createFakePollingRuntime([HealthyCollection])

    // When: real polling begins.
    const result = await pollRealFlowMetrics(PollingRequest, runtime)

    // Then: no retry clock is advanced.
    expect(result).toBe(HealthyCollection)
    expect(runtime.attemptedAtMs).toEqual([0])
    expect(runtime.waitsMs).toEqual([])
  })

  it("propagates arbitrary collector failures without reclassification", async () => {
    // Given: the collector throws an infrastructure/programmer exception.
    const failure = new TypeError("collector contract failure"),
      fake = createFakePollingRuntime([HealthyCollection]),
      runtime = {
        ...fake,
        collect: async () => Promise.reject(failure)
      }

    // When / Then: only representable strict health is retryable.
    await expect(pollRealFlowMetrics(PollingRequest, runtime)).rejects.toBe(
      failure
    )
    expect(fake.waitsMs).toEqual([])
  })
})

async function nonHealthyCase(name: string) {
  nonHealthyCasesPromise ??= createNonHealthyCases()
  const found = (await nonHealthyCasesPromise).find(value => value.name === name)
  if (found === undefined) throw new TypeError(`missing polling case ${name}`)
  return found
}
