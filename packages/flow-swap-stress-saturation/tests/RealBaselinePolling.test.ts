import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import type { EnvelopeBaselineCaptureResult } from "@wireio/debugging-shared"
import {
  pollRealFlowBaseline,
  RealFlowMetricPolling
} from "@wireio/test-flow-swap-stress-saturation"
import type { RealBaselinePollingRuntime } from "@wireio/test-flow-swap-stress-saturation"

import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"

const LastPreDeadlinePollMs = 237_000,
  ExpectedPersistentCallCount = 80

describe("real flow baseline polling", () => {
  it("returns an immediate capture after one attempt without waiting", async () => {
    // Given: the first strict baseline scan captures successfully.
    const captured = {
        kind: "captured" as const,
        baseline: createEnvelopeBaseline(["existing"])
      },
      runtime = createFakeBaselineRuntime([captured])

    // When: real baseline polling begins.
    const result = await pollRealFlowBaseline(runtime)

    // Then: the captured object returns without advancing policy time.
    expect(result).toBe(captured)
    expect(runtime.attemptedAtMs).toEqual([0])
    expect(runtime.waitsMs).toEqual([])
  })

  it("captures on attempt 80 at the last pre-deadline poll", async () => {
    // Given: baseline scans fail until the final legal attempt at 237 seconds.
    const failed = {
        kind: "failed" as const,
        issues: orderedBaselineCaptureIssues()
      },
      captured = {
        kind: "captured" as const,
        baseline: createEnvelopeBaseline(["repaired"])
      },
      runtime = createFakeBaselineRuntime([
        ...Array(ExpectedPersistentCallCount - 1).fill(failed),
        captured
      ])

    // When: polling repairs the baseline at the last pre-deadline attempt.
    const result = await pollRealFlowBaseline(runtime)

    // Then: attempt 80 succeeds after exactly 79 fixed waits.
    expect(result).toBe(captured)
    expect(runtime.attemptedAtMs).toHaveLength(ExpectedPersistentCallCount)
    expect(runtime.attemptedAtMs.at(-1)).toBe(LastPreDeadlinePollMs)
    expect(runtime.waitsMs).toEqual(
      Array(ExpectedPersistentCallCount - 1).fill(
        RealFlowMetricPolling.LongPollIntervalMs
      )
    )
  })

  it("returns the exact final failure after waiting to the deadline", async () => {
    // Given: every legal attempt returns a distinct failed result and issue.
    const failures = Array.from(
        { length: ExpectedPersistentCallCount },
        () => ({
          kind: "failed" as const,
          issues: orderedBaselineCaptureIssues()
        })
      ),
      finalFailure = failures[failures.length - 1],
      runtime = createFakeBaselineRuntime(failures)
    if (finalFailure === undefined) throw new TypeError("final failure missing")

    // When: baseline polling exhausts the fixed deadline.
    const result = await pollRealFlowBaseline(runtime)

    // Then: no deadline capture occurs and exact final failure evidence survives.
    expect(result).toBe(finalFailure)
    expect(result.kind).toBe("failed")
    if (result.kind !== "failed") throw new TypeError("failed result expected")
    expect(result.issues).toBe(finalFailure.issues)
    expect(result.issues.map(issue => issue.code)).toEqual(
      finalFailure.issues.map(issue => issue.code)
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
  })

  it("propagates a rejected capture promise unchanged", async () => {
    // Given: the strict baseline capture rejects outside its result contract.
    const failure = new TypeError("capture contract failure"),
      fake = createFakeBaselineRuntime([]),
      runtime: RealBaselinePollingRuntime = {
        ...fake,
        capture: async () => Promise.reject(failure)
      }

    // When / Then: arbitrary capture rejection is not caught or reclassified.
    await expect(pollRealFlowBaseline(runtime)).rejects.toBe(failure)
    expect(fake.waitsMs).toEqual([])
  })
})

function createFakeBaselineRuntime(
  results: readonly EnvelopeBaselineCaptureResult[]
): RealBaselinePollingRuntime & {
  readonly attemptedAtMs: number[]
  readonly waitsMs: number[]
} {
  let nowMs = 0,
    index = 0
  const attemptedAtMs: number[] = [],
    waitsMs: number[] = []
  return {
    attemptedAtMs,
    waitsMs,
    now: () => nowMs,
    wait: async milliseconds => {
      waitsMs.push(milliseconds)
      nowMs += milliseconds
    },
    capture: async () => {
      attemptedAtMs.push(nowMs)
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      if (result === undefined) throw new TypeError("fake capture has no result")
      return result
    }
  }
}
