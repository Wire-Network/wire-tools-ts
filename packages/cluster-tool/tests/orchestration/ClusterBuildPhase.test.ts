import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildFailureMode,
  ClusterBuildPhase,
  ClusterBuildStep, pollUntil, type StepInput } from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { sleep } from "@wireio/cluster-tool/utils"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

/** The typed input the capture test threads through a step into its StepResult. */
interface CaptureStepInput extends StepInput {
  readonly kind: "T"
  /** An arbitrary payload value asserted verbatim in the StepResult. */
  v: number
}

function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("phase-test"))
  )
}

const ok = (order: string[], name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    order.push(name)
  })

const fail = (name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    throw new Error(`${name} boom`)
  })

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

  it("collect mode runs every sequential step after failures", async () => {
    const order: string[] = []
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      failureMode: ClusterBuildFailureMode.collect
    }).push(ok(order, "a"), fail("b"), ok(order, "c"))
    const result = await runOne(phase)
    expect(order).toEqual(["a", "c"])
    expect(result.steps.map(step => step.status)).toEqual([
      Report.StepStatus.ok,
      Report.StepStatus.failed,
      Report.StepStatus.ok
    ])
  })

  it("collect mode does not cancel parallel siblings after a failure", async () => {
    const order: string[] = []
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }).push(fail("a"), ok(order, "b"), ok(order, "c"))
    const result = await runOne(phase)
    expect(order.sort()).toEqual(["b", "c"])
    expect(
      result.steps.filter(step => step.status === Report.StepStatus.failed)
    ).toHaveLength(1)
  })

  it("fail-fast mode aborts an in-flight parallel sibling", async () => {
    let siblingSawAbort = false
    const delayedFailure = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "failure",
      "failure",
      {},
      null,
      async () => {
        await sleep(10)
        throw new Error("failure boom")
      }
    )
    const abortAwareSibling = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "sibling",
      "sibling",
      {},
      null,
      async (_ctx, _input, signal) =>
        new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            siblingSawAbort = true
            reject(new Error("sibling cancelled"))
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
    )
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true
    }).push(delayedFailure, abortAwareSibling)

    await runOne(phase)

    expect(siblingSawAbort).toBe(true)
  })

  it("collect mode isolates a timed-out step from parallel siblings", async () => {
    const order: string[] = []
    const timedOut = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "timed-out",
      "timed-out",
      { timeoutMs: 10 },
      null,
      async () => sleep(100)
    )
    const sibling = ClusterBuildStep.create(
      Report.Actor.Sysio,
      "sibling",
      "sibling",
      {},
      null,
      async () => {
        await sleep(30)
        order.push("sibling")
      }
    )
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }).push(timedOut, sibling)

    const result = await runOne(phase)

    expect(order).toEqual(["sibling"])
    expect(result.steps.map(step => step.status)).toEqual([
      Report.StepStatus.failed,
      Report.StepStatus.ok
    ])
  })

  it("runs steps in parallel when parallelize", async () => {
    const order: string[] = []
    const timed = (name: string, ms: number) =>
      ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
        await sleep(ms)
        order.push(name)
      })
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true
    }).push(timed("slow", 40), timed("fast", 5))
    const result = await runOne(phase)
    expect(order).toEqual(["fast", "slow"]) // started together; fast lands first
    expect(result.steps.every(step => step.status === Report.StepStatus.ok)).toBe(true)
  })

  it("caps steps in flight at `concurrency` when parallelize", async () => {
    let inFlight = 0
    let peakInFlight = 0
    const tracked = (name: string) =>
      ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        await sleep(10)
        inFlight -= 1
      })
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true,
      concurrency: 2
    }).push(tracked("a"), tracked("b"), tracked("c"), tracked("d"))
    const result = await runOne(phase)
    expect(peakInFlight).toBe(2)
    expect(result.steps.every(step => step.status === Report.StepStatus.ok)).toBe(true)
  })

  it("leaves parallelize unbounded when no concurrency is given", async () => {
    let inFlight = 0
    let peakInFlight = 0
    const tracked = (name: string) =>
      ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        await sleep(10)
        inFlight -= 1
      })
    const phase = ClusterBuildPhase.create(newBuild(), "P", "d", [], {
      parallelize: true
    }).push(tracked("a"), tracked("b"), tracked("c"), tracked("d"))
    await runOne(phase)
    expect(peakInFlight).toBe(4) // all at once — unchanged from Promise.all
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
    const phase = ClusterBuildPhase.create(build, "P", "scaled ceiling", []).push(
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
    expect((nodes[0] as Report.Phase).steps[0].status).toBe(Report.StepStatus.ok)
  })

  it("without the scale the same step times out (control)", async () => {
    const build = newBuild()
    const phase = ClusterBuildPhase.create(build, "P", "unscaled ceiling", []).push(
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
