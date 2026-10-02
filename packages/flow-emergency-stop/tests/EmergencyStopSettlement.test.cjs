const Assert = require("node:assert/strict")
const {test, afterEach, mock} = require("node:test")
const {ClusterBuild, OutputStore, SyndicationScenario, SolanaFundingTool, SolanaLiqSyndicationTool, WireSyndicationTool} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
const {EmergencyStopScenario} = require("../lib/EmergencyStopScenario.js")
const {EmergencyStopScenarioConstants: Constants} = require("../lib/EmergencyStopScenarioConstants.js")
afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

for (const complete of [true, false]) test(`settlement requires the complete destination balance: ${complete}`, async () => {
  const ctx = {outputs: new OutputStore(), config: {dataPath: "/tmp/unused-unit-wallet"}},
    build = ClusterBuild.forContext(ctx), baseline = 123456n,
    expected = Constants.Remaining + Constants.HeldAmount + baseline + 2n * Constants.ProbeAmount + Constants.Deficit,
    balance = complete ? expected : expected - 1n
  new EmergencyStopScenario().plan(build)
  const step = steps(build).find(value => value.name === "recovery-deposits-in-wallet")
  Assert.ok(step, "flow must contain its final wallet settlement assertion")
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), "destination remains incomplete")
  })
  mock.method(SyndicationScenario, "readBalance", async () => balance)
  
  ctx.outputs.set(Constants.Shortfall, baseline)

  const run = () => step.runner(ctx, step.input, new AbortController().signal)
  if (complete) await run()
  else await Assert.rejects(run, /destination remains incomplete/)
})
