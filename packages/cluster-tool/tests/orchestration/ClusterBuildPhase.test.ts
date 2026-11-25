import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildStep,
  pollUntil,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { MaxTimerDelayMs, sleep } from "@wireio/cluster-tool/utils"
import { Deferred } from "@wireio/shared"
import { fixtureConfig } from "../config/clusterConfigFixture.js"
import {
  ConcurrencyProbeKey,
  planGatedStep,
  planInFlightTrackingStep,
  rendezvous
} from "./clusterBuildFixture.js"

/** The typed input the capture test threads through a step into its StepResult. */
interface CaptureStepInput extends StepInput {
  readonly kind: "T"
  /** An arbitrary payload value asserted verbatim in the StepResult. */
  v: number
}

function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger(__filename))
  )
}

const ok = (order: string[], name: string) =>
  ClusterBuildStep.create(
    Report.Actor.Sysio,
    name,
    name,
    {},
    null,
    async () => {
      order.push(name)
    }
  )

const fail = (name: string) =>
  ClusterBuildStep.create(
    Report.Actor.Sysio,
    name,
    name,
    {},
    null,
    async () => {
      throw new Error(`${name} boom`)
    }
  )

/** Run a phase to its single Report.Phase node (the base returns Node[]). */
const runOne = (phase: ClusterBuildPhase): Promise<Report.Phase> =>
  phase
    .run(new AbortController().signal)
    .then(nodes => nodes[0] as Report.Phase)

describe("ClusterBuildPhase executor", () => {
  it("runs steps sequentially in order; all ok → phase succeeded", async () => {
    const order: string[] = []
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d").push(
      ok(order, "a"),
      ok(order, "b"),
      ok(order, "c")
    )
    const result = await runOne(phase)
    expect(order).toEqual(["a", "b", "c"])
    expect(result.succeeded).toBe(true)
    expect(result.steps.map(step => step.status)).toEqual([
      Report.StepStatus.ok,
      Report.StepStatus.ok,
      Report.StepStatus.ok
    ])
  })

  it("marks a failing step failed + skips the rest (sequential abort)", async () => {
    const order: string[] = []
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d").push(
      ok(order, "a"),
      fail("b"),
      ok(order, "c")
    )
    const result = await runOne(phase)
    expect(order).toEqual(["a"]) // c never ran
    expect(result.steps.map(step => step.status)).toEqual([
      Report.StepStatus.ok,
      Report.StepStatus.failed,
      Report.StepStatus.skipped
    ])
    expect(result.steps[1].error?.message).toBe("b boom")
    expect(result.succeeded).toBe(false)
  })

  it("runs steps in parallel when parallelize", async () => {
    const order: string[] = []
    const bothStarted = rendezvous(2)
    const build = newBuild()
    build.context.outputs.set(ConcurrencyProbeKey, {
      order,
      counter: { inFlight: 0, peak: 0 },
      barrier: bothStarted
    })
    const phase = ClusterBuildPhase.create(build, "P", "d", [], {
      parallelize: true
    }).push(
      planGatedStep(Report.Actor.Sysio, "first"),
      planGatedStep(Report.Actor.Sysio, "second")
    )
    const result = await runOne(phase)
    expect(
      result.steps.every(step => step.status === Report.StepStatus.ok)
    ).toBe(true)
    expect(order.slice(0, 2).sort()).toEqual(["start:first", "start:second"]) // both started...
    expect(order.slice(2).sort()).toEqual(["end:first", "end:second"]) // ...before either ended
  })

  it("caps steps in flight at `concurrency` when parallelize", async () => {
    const counter = { inFlight: 0, peak: 0 }
    const cap = 2
    const capInFlight = rendezvous(cap)
    const names = ["a", "b", "c", "d"]
    const build = newBuild()
    build.context.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: capInFlight
    })
    const phase = ClusterBuildPhase.create(build, "P", "d", [], {
      parallelize: true,
      concurrency: cap
    }).push(
      ...names.map(name => planInFlightTrackingStep(Report.Actor.Sysio, name))
    )
    const result = await runOne(phase)
    expect(counter.peak).toBe(cap)
    expect(
      result.steps.every(step => step.status === Report.StepStatus.ok)
    ).toBe(true)
  })

  it("leaves parallelize unbounded when no concurrency is given", async () => {
    const counter = { inFlight: 0, peak: 0 }
    const names = ["a", "b", "c", "d"]
    const allInFlight = rendezvous(names.length)
    const build = newBuild()
    build.context.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: allInFlight
    })
    const phase = ClusterBuildPhase.create(build, "P", "d", [], {
      parallelize: true
    }).push(
      ...names.map(name => planInFlightTrackingStep(Report.Actor.Sysio, name))
    )
    await runOne(phase)
    expect(counter.peak).toBe(names.length) // all at once — unchanged from Promise.all
  })

  it("fails a step that exceeds its timeout", async () => {
    const slow = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "slow",
      "slow",
      { timeoutMs: 20 },
      null,
      async () => {
        await sleep(150)
      }
    )
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d").push(slow)
    const result = await runOne(phase)
    expect(result.steps[0].status).toBe(Report.StepStatus.failed)
    expect(result.steps[0].error?.message).toMatch(/exceeded 20ms/)
  })

  it("a satisfied timeout is disarmed — the stale timer never aborts later steps", async () => {
    const order: string[] = []
    // quick: resolves at ~2ms with a 30ms timeout. Without disarming, its
    // timer fires at 30ms — mid "slow" — aborting the SHARED controller and
    // skipping "tail" (the run-2 PhaseA failure shape).
    const quick = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "quick",
      "quick",
      { timeoutMs: 30 },
      null,
      async () => {
        await sleep(2)
        order.push("quick")
      }
    )
    const slow = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "slow",
      "slow",
      {},
      null,
      async () => {
        await sleep(60)
        order.push("slow")
      }
    )
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d").push(
      quick,
      slow,
      ok(order, "tail")
    )
    const result = await runOne(phase)
    expect(order).toEqual(["quick", "slow", "tail"])
    expect(result.steps.map(step => step.status)).toEqual([
      Report.StepStatus.ok,
      Report.StepStatus.ok,
      Report.StepStatus.ok
    ])
    expect(result.succeeded).toBe(true)
  })

  it("a step ceiling past Node's timer limit neither fires early nor leaves a timer behind", async () => {
    jest.useFakeTimers()
    try {
      // A seven-day economic epoch's remit Step ceiling.
      const ceilingMs = 2_419_350_000,
        body = new Deferred<void>(),
        step = ClusterBuildStep.create(
          Report.Actor.Sysio,
          "long",
          "long",
          { timeoutMs: ceilingMs },
          null,
          () => body.promise
        ),
        result = runOne(
          ClusterBuildPhase.create(newBuild(), "P", "d").push(step)
        )
      expect(ceilingMs).toBeGreaterThan(MaxTimerDelayMs)
      // A native setTimeout of this length overflows and fails the step after 1 ms.
      await jest.advanceTimersByTimeAsync(MaxTimerDelayMs + 1_000)
      body.resolve()
      expect((await result).steps[0].status).toBe(Report.StepStatus.ok)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("a step past a ceiling longer than Node's timer limit still times out at its ceiling", async () => {
    jest.useFakeTimers()
    try {
      const ceilingMs = 2 * MaxTimerDelayMs + 5,
        step = ClusterBuildStep.create(
          Report.Actor.Sysio,
          "stuck",
          "stuck",
          { timeoutMs: ceilingMs },
          null,
          () => new Deferred<void>().promise
        ),
        result = runOne(
          ClusterBuildPhase.create(newBuild(), "P", "d").push(step)
        )
      await jest.advanceTimersByTimeAsync(ceilingMs - 1)
      expect(jest.getTimerCount()).toBe(1)
      await jest.advanceTimersByTimeAsync(1)
      const [stepResult] = (await result).steps
      expect(stepResult.status).toBe(Report.StepStatus.failed)
      expect(stepResult.error?.message).toContain(
        `step exceeded ${ceilingMs}ms`
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("captures actor + typed input into the StepResult", async () => {
    const step = ClusterBuildStep.create<ClusterBuildContext, CaptureStepInput>(
      Report.Actor.User,
      "s",
      "s",
      {},
      { kind: "T", v: 7 },
      async () => {}
    )
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d").push(step)
    const result = await runOne(phase)
    expect(result.steps[0].actor).toBe(Report.Actor.User)
    expect(result.steps[0].input).toEqual({ kind: "T", v: 7 })
  })
})

describe("step timeout scaling (WIRE_FLOW_TIMEOUT_SCALE)", () => {
  afterEach(() => {
    delete process.env[pollUntil.TimeoutScaleEnvVar]
  })

  it("a step ceiling stretches by the flow-wide scale", async () => {
    process.env[pollUntil.TimeoutScaleEnvVar] = "3"
    const build = newBuild()
    const phase = ClusterBuildPhase.create(
      build,
      "P",
      "scaled ceiling",
      []
    ).push(
      ClusterBuildStep.create(
        Report.Actor.Sysio,
        "slow-but-fine",
        "sleeps past the UNSCALED ceiling",
        { timeoutMs: 40 },
        null,
        async () => {
          await new Promise(resolve => setTimeout(resolve, 80))
        }
      )
    )
    const nodes = await phase.run(new AbortController().signal)
    expect((nodes[0] as Report.Phase).steps[0].status).toBe(
      Report.StepStatus.ok
    )
  })

  it("without the scale the same step times out (control)", async () => {
    const build = newBuild()
    const phase = ClusterBuildPhase.create(
      build,
      "P",
      "unscaled ceiling",
      []
    ).push(
      ClusterBuildStep.create(
        Report.Actor.Sysio,
        "too-slow",
        "sleeps past the ceiling",
        { timeoutMs: 40 },
        null,
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      )
    )
    const nodes = await phase.run(new AbortController().signal)
    const step = (nodes[0] as Report.Phase).steps[0]
    expect(step.status).toBe(Report.StepStatus.failed)
    expect(step.error?.message).toContain("step exceeded")
  })
})
