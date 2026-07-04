import { pollStep, pollUntil, verifyStep } from "@wireio/test-cluster-tool/orchestration"
import { ClusterBuildContext } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("pollUntil.timeoutScale", () => {
  afterEach(() => {
    delete process.env[pollUntil.TimeoutScaleEnvVar]
  })

  it("defaults to 1 when unset or invalid", () => {
    expect(pollUntil.timeoutScale()).toBe(1)
    process.env[pollUntil.TimeoutScaleEnvVar] = "not-a-number"
    expect(pollUntil.timeoutScale()).toBe(1)
  })

  it("clamps into [MinTimeoutScale, MaxTimeoutScale]", () => {
    process.env[pollUntil.TimeoutScaleEnvVar] = "0.25"
    expect(pollUntil.timeoutScale()).toBe(pollUntil.MinTimeoutScale)
    process.env[pollUntil.TimeoutScaleEnvVar] = "99"
    expect(pollUntil.timeoutScale()).toBe(pollUntil.MaxTimeoutScale)
    process.env[pollUntil.TimeoutScaleEnvVar] = "2"
    expect(pollUntil.timeoutScale()).toBe(2)
  })

  it("stretches the deadline (timeout message carries the scaled budget)", async () => {
    process.env[pollUntil.TimeoutScaleEnvVar] = "3"
    await expect(
      pollUntil("never", async () => false, 20, 5)
    ).rejects.toThrow("Timed out waiting for: never (60ms)")
  })

  it("does not delay a satisfied poll", async () => {
    process.env[pollUntil.TimeoutScaleEnvVar] = "5"
    const startedAt = Date.now()
    await pollUntil("immediate", async () => true, 10_000, 1_000)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })
})

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
