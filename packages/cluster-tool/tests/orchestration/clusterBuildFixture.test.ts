import { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../config/clusterConfigFixture.js"
import {
  RendezvousTimeoutMs,
  ConcurrencyProbeKey,
  planGatedStep,
  planInFlightTrackingStep,
  runGatedStep,
  runInFlightTrackingStep,
  rendezvous
} from "./clusterBuildFixture.js"

/** Short rendezvous ceiling so the timeout cases need no real wait. */
const ShortTimeoutMs = 20

const newContext = () =>
  new ClusterBuildContext(fixtureConfig(), getLogger(__filename))

describe("rendezvous", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("defaults its ceiling to RendezvousTimeoutMs", async () => {
    jest.useFakeTimers()
    const wait = rendezvous(2)()
    let settled = false
    wait.catch(() => {
      settled = true
    })
    jest.advanceTimersByTime(RendezvousTimeoutMs - 1)
    await Promise.resolve()
    expect(settled).toBe(false) // still pending one tick short of the ceiling
    jest.advanceTimersByTime(1)
    await expect(wait).rejects.toThrow(/only 1 of 2 parties/)
  })

  it("releases every party once all N have arrived", async () => {
    const arrive = rendezvous(3)
    const released: number[] = []
    const parties = [1, 2, 3].map(id => arrive().then(() => released.push(id)))
    await Promise.all(parties)
    expect(released.sort()).toEqual([1, 2, 3])
  })

  it("holds an early party until the last one arrives", async () => {
    const arrive = rendezvous(2)
    let released = false
    const first = arrive().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    await arrive()
    await first
    expect(released).toBe(true)
  })

  it("rejects with the arrival count when only N-1 parties arrive", async () => {
    const arrive = rendezvous(3, ShortTimeoutMs)
    const results = await Promise.allSettled([arrive(), arrive()])
    for (const result of results) {
      expect(result.status).toBe("rejected")
      expect((result as PromiseRejectedResult).reason.message).toMatch(
        new RegExp(`only \\d of 3 parties arrived within ${ShortTimeoutMs}ms`)
      )
    }
  })

  it("leaves no timer pending after a release", async () => {
    jest.useFakeTimers()
    const arrive = rendezvous(2)
    const waits = [arrive(), arrive()]
    await Promise.all(waits)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("leaves no timer pending after a timeout rejection", async () => {
    jest.useFakeTimers()
    const arrive = rendezvous(2, ShortTimeoutMs)
    const wait = arrive()
    jest.advanceTimersByTime(ShortTimeoutMs)
    await expect(wait).rejects.toThrow(/only 1 of 2 parties/)
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe("step factories", () => {
  it("planGatedStep records start then end using the execution context", async () => {
    const order: string[] = []
    const step = planGatedStep(Report.Actor.Sysio, "s")
    const ctx = newContext()
    ctx.outputs.set(ConcurrencyProbeKey, {
      order,
      counter: { inFlight: 0, peak: 0 },
      barrier: async () => {
        order.push("barrier")
      }
    })
    expect(step.runner).toBe(runGatedStep)
    expect(step.input).toEqual({
      kind: "clusterBuildFixture.GatedStepInput",
      name: "s"
    })
    await step.runner(ctx, step.input, new AbortController().signal)
    expect(order).toEqual(["start:s", "barrier", "end:s"])
  })

  it("planInFlightTrackingStep counts in flight during the barrier and releases after", async () => {
    const counter = { inFlight: 0, peak: 0 }
    const seen: number[] = []
    const step = planInFlightTrackingStep(Report.Actor.Sysio, "s")
    const ctx = newContext()
    ctx.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: async () => {
        seen.push(counter.inFlight)
      }
    })
    expect(step.runner).toBe(runInFlightTrackingStep)
    await step.runner(ctx, step.input, new AbortController().signal)
    expect(seen).toEqual([1])
    expect(counter).toEqual({ inFlight: 0, peak: 1 })
  })

  it("gated runners reject a missing context probe", async () => {
    const step = planGatedStep(Report.Actor.Sysio, "s")
    await expect(
      step.runner(newContext(), step.input, new AbortController().signal)
    ).rejects.toThrow(/Missing asserted output: test.concurrencyProbe/)
  })

  it("gated runners record no end marker when the barrier rejects", async () => {
    const ctx = newContext(),
      order: string[] = [],
      error = new Error("barrier failed")
    ctx.outputs.set(ConcurrencyProbeKey, {
      order,
      counter: { inFlight: 0, peak: 0 },
      barrier: () => Promise.reject(error)
    })
    const step = planGatedStep(Report.Actor.Sysio, "s")
    await expect(
      step.runner(ctx, step.input, new AbortController().signal)
    ).rejects.toBe(error)
    expect(order).toEqual(["start:s"])
  })

  it("tracking runners release the live count when the barrier rejects", async () => {
    const ctx = newContext(),
      counter = { inFlight: 0, peak: 0 },
      error = new Error("barrier failed")
    ctx.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: () => Promise.reject(error)
    })
    const step = planInFlightTrackingStep(Report.Actor.Sysio, "s")
    await expect(
      step.runner(ctx, step.input, new AbortController().signal)
    ).rejects.toBe(error)
    expect(counter).toEqual({ inFlight: 0, peak: 1 })
  })
})
