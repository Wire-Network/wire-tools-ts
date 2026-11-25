const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  BatchOperatorUnderwritingSteps,
  OutputStore,
  Steps,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
const { SyndicationPluginUnderwritingCapSteps } = require("../../lib/steps/SyndicationPluginUnderwritingCapSteps.js")

afterEach(() => mock.restoreAll())

/** The one funded operator, its exposure cap, and the plan keys the step reads and writes. */
const Funded = "batchop.a",
  Cap = 10_000_000_000n,
  plan = BatchOperatorUnderwritingSteps.createPlan("cap-test")

/** A context holding the first request's id and epoch. */
function context() {
  return { outputs: new OutputStore().set(plan.firstRequest, "7").set(plan.firstEpoch, 4) }
}

/** The funded operator holding an unpaid bond at the cap, and no second intake yet. */
function firstBondOutstanding() {
  mock.method(BatchOperatorUnderwritingSteps, "fundedOperatorAccounts", () => [Funded])
  mock.method(BatchOperatorUnderwritingSteps, "maxExposure", () => Cap)
  mock.method(WireSyndicationTool, "readBonds", async () => [{ underwriter: Funded, paid: false, amount: Cap.toString() }])
  mock.method(WireSyndicationTool, "readEnvelopes", async () => [])
}

test("the second-intake wait pushes no traffic while the second intake has not reached the depot: its backlog report drives Solana", async () => {
  firstBondOutstanding()
  const states = mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({})),
    push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  mock.method(StepTools, "pollFor", async (label, read) => {
    const value = await read()
    Assert.ok(value != null, `Timed out waiting for: ${label}`)
    return value
  })
  const step = SyndicationPluginUnderwritingCapSteps.planVerifySecondRequested("Sysio", "second-requested", "probe", {}, plan)
  await Assert.rejects(step.runner(context(), null, new AbortController().signal), /second request issued and held/)
  Assert.equal(push.mock.callCount(), 0)
  Assert.equal(states.mock.callCount(), 0)
})

test("an aborted second-intake wait pushes no traffic", async () => {
  firstBondOutstanding()
  const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  const step = SyndicationPluginUnderwritingCapSteps.planVerifySecondRequested("Sysio", "second-requested", "probe", {}, plan)
  await Assert.rejects(step.runner(context(), null, AbortSignal.abort()))
  Assert.equal(push.mock.callCount(), 0)
})
