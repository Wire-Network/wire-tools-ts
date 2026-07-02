import { pollStep, pollUntil, verifyStep } from "@wireio/test-cluster-tool/orchestration"
import { ClusterBuildContext } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("pollUntil", () => {
  it("resolves once the predicate returns true", async () => {
    let calls = 0
    await pollUntil("counter reaches 3", async () => (++calls) >= 3, 1_000, 2)
    expect(calls).toBe(3)
  })

  it("throws a labelled timeout when the deadline elapses", async () => {
    await expect(
      pollUntil("never", async () => false, 30, 5)
    ).rejects.toThrow(/Timed out waiting for: never \(30ms\)/)
  })
})

describe("verifyStep", () => {
  it("builds an input-less step attributed to the actor, with a runner", () => {
    const step = verifyStep(
      Report.Actor.Sysio,
      "verify-thing",
      "verify a thing holds",
      async () => undefined
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("runner delegates to the verification fn (a throw surfaces)", async () => {
    const step = verifyStep(
      Report.Actor.User,
      "failing-check",
      "a check that fails",
      async () => {
        throw new Error("boom")
      }
    )
    await expect(
      step.runner(null as never, null, new AbortController().signal)
    ).rejects.toThrow("boom")
  })
})

describe("pollStep.lift", () => {
  it("returns a fn that polls the predicate to resolution", async () => {
    let calls = 0
    const fn = pollStep.lift<ClusterBuildContext>(
      "counter reaches 2",
      async () => (++calls) >= 2,
      1_000,
      2
    )
    expect(typeof fn).toBe("function")
    // predicate ignores ctx, so a null stand-in is fine at runtime
    await fn(null as unknown as ClusterBuildContext)
    expect(calls).toBe(2)
  })
})
