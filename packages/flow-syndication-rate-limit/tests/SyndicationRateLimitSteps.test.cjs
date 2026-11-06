const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { OutputStore, Report, Steps } = require("@wireio/cluster-tool")
const { SyndicationRateLimitSteps } = require("../lib/steps/SyndicationRateLimitSteps.js")
const { SyndicationRateLimitScenarioConstants: Constants } = require("../lib/SyndicationRateLimitScenarioConstants.js")

afterEach(() => mock.restoreAll())

for (const refused of [false, true]) {
  test(`shared quoted return records the budget refusal: ${refused}`, async () => {
    const ctx = { outputs: new OutputStore() },
      step = SyndicationRateLimitSteps.planRefusedDesyndication(Report.Actor.User, "return", "try return", {}),
      stub = mock.method(Steps.contracts.sysio.synd, "runQuotedDesyndicate", async (_ctx, input) => {
        Assert.equal(_ctx, ctx)
        Assert.deepEqual(input, { kind: "SyndContractSteps.QuotedDesyndicateInput", data: step.input.data })
        if (refused) throw new Error("desyndication budget exhausted")
      })
    await step.runner(ctx, step.input, new AbortController().signal)
    Assert.equal(stub.mock.calls.length, 1)
    Assert.equal(ctx.outputs.assert(Constants.Refusal), refused ? "Error: desyndication budget exhausted" : "")
  })
}

test("aborted return never reaches the shared quote runner", async () => {
  const ctx = { outputs: new OutputStore() },
    step = SyndicationRateLimitSteps.planRefusedDesyndication(Report.Actor.User, "return", "try return", {}),
    stub = mock.method(Steps.contracts.sysio.synd, "runQuotedDesyndicate", async () => {})
  await Assert.rejects(step.runner(ctx, step.input, AbortSignal.abort()))
  Assert.equal(stub.mock.calls.length, 0)
})
