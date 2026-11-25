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

for (const accepted of [true, false]) test(`under the cord the frozen-epoch wait keeps Solana alone due until it advances with an accepted Solana envelope: ${accepted}`, async () => {
  const {Steps} = require("@wireio/cluster-tool"),
    ctx = {
      outputs: new OutputStore(),
      config: {dataPath: "/tmp/unused-unit-wallet"},
      wire: {
        getSysioContract: () => ({
          tables: {
            envlog: {
              query: async () => ({
                rows: accepted ? [{id: "12", endpoints: {start: {kind: "CHAIN_KIND_SVM"}, end: {kind: "CHAIN_KIND_WIRE"}}}] : [],
                more: false
              })
            },
            buckets: {query: async () => ({rows: [], more: false})}
          }
        })
      }
    },
    build = ClusterBuild.forContext(ctx),
    idle = {current_epoch_index: 5, due_at: "1970-01-01T00:00:00.000", is_paused: false}
  new EmergencyStopScenario().plan(build)
  const step = steps(build).find(value => value.name === "frozen-epochs-and-buckets")
  ctx.outputs.set(Constants.FreezeEpoch, 5).set(Constants.EnvelopeLogId, 10n).set(Constants.Buckets, [])
  mock.method(SyndicationScenario, "readEpoch", async () => 6)
  mock.method(SyndicationScenario, "readEnvelope", async () => ({released: "0"}))
  mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({ETHEREUM: idle, SOLANA: idle}))
  const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  const run = () => step.runner(ctx, step.input, new AbortController().signal)
  if (accepted) {
    await run()
    Assert.equal(push.mock.callCount(), 0)
  } else {
    await Assert.rejects(run, /Timed out waiting for: epoch advance and an accepted Solana envelope/)
    Assert.deepEqual(push.mock.calls.map(call => call.arguments[1].data.chain_code), [SyndicationScenario.Chain])
  }
})
