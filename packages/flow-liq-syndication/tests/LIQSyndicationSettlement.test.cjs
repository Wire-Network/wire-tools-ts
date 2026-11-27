const Assert = require("node:assert/strict")
const {test, afterEach, mock} = require("node:test")
const {ClusterBuild, Constants: HarnessConstants, OutputStore, ProtocolTiming, Steps, SyndicationScenario, SolanaFundingTool, SolanaLiqSyndicationTool, WireSyndicationTool} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
const {LIQSyndicationScenario} = require("../lib/LIQSyndicationScenario.js")
const {LIQSyndicationScenarioConstants: Constants} = require("../lib/LIQSyndicationScenarioConstants.js")
afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** Every outpost chain at the flow's duration — what the plan sizes its ceilings from. */
const OutpostEpochDurationSec = Object.fromEntries(
  Object.values(HarnessConstants.OutpostChainCodename).map(chain => [chain, Constants.EpochDurationSec])
)

test("every chain's epoch index is snapshotted before the syndication and must advance past it", () => {
  const config = {outpostEpochDurationSec: OutpostEpochDurationSec},
    build = ClusterBuild.forContext({outputs: new OutputStore(), config})
  new LIQSyndicationScenario().plan(build)
  const planned = steps(build),
    [snapshot] = planned,
    advances = planned.find(value => value.name === "epoch-index-advances")
  Assert.equal(snapshot.runner, Steps.epochAdvance.runRecordEpochIndices)
  Assert.equal(snapshot.input.snapshotName, Constants.PreSyndicationEpochSnapshot)
  Assert.equal(advances.runner, Steps.epochAdvance.runVerifyEpochIndicesAdvanced)
  Assert.equal(advances.input.snapshotName, Constants.PreSyndicationEpochSnapshot)
  Assert.ok(planned.indexOf(advances) > planned.findIndex(value => value.name === "syndication-in-wallet"))
  Assert.equal(
    advances.options.timeoutMs,
    Steps.epochAdvance.everyChainAdvanceBudgetMs(config) + ProtocolTiming.PollDeadlineBufferMs
  )
})

test("planning needs the resolved config the epoch-advance ceiling derives from", () => {
  Assert.throws(() => new LIQSyndicationScenario().plan(ClusterBuild.forContext({outputs: new OutputStore()})))
})

for (const complete of [true, false]) test(`settlement requires the complete destination balance: ${complete}`, async () => {
  const ctx = {outputs: new OutputStore(), config: {dataPath: "/tmp/unused-unit-wallet", outpostEpochDurationSec: OutpostEpochDurationSec}},
    build = ClusterBuild.forContext(ctx), baseline = 123456n,
    expected = Constants.SyndicateAmount,
    balance = complete ? expected : expected - 1n
  new LIQSyndicationScenario().plan(build)
  const step = steps(build).find(value => value.name === "syndication-in-wallet")
  Assert.ok(step, "flow must contain its final wallet settlement assertion")
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), "destination remains incomplete")
  })
  mock.method(SyndicationScenario, "readBalance", async () => balance)
  
  mock.method(SolanaFundingTool, "loadKeypair", () => ({publicKey: {toBuffer: () => Buffer.alloc(32)}}))
  mock.method(WireSyndicationTool, "readParked", async () => undefined)

  const run = () => step.runner(ctx, step.input, new AbortController().signal)
  if (complete) await run()
  else await Assert.rejects(run, /destination remains incomplete/)
})
