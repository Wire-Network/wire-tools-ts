const Assert = require("node:assert/strict")
const {
  ClusterBuild,
  Constants,
  OutputStore,
  ProtocolTiming,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  Steps,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const { LIQYieldScenario } = require("../lib/LIQYieldScenario.js")
const { LIQYieldScenarioConstants } = require("../lib/LIQYieldScenarioConstants.js")

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** The resolved config the plan sizes its ceilings from: every outpost chain at the flow's duration. */
const Config = {
  outpostEpochDurationSec: Object.fromEntries(
    Object.values(Constants.OutpostChainCodename).map(chain => [chain, LIQYieldScenarioConstants.EpochDurationSec])
  )
}

test("every chain's epoch index is snapshotted before any write and must advance past it at the end", () => {
  const build = ClusterBuild.forContext({ outputs: new OutputStore(), config: Config }),
    bonder = jest.spyOn(Steps.registry, "readMockSyndicationBonder").mockReturnValue({})
  try {
    new LIQYieldScenario().plan(build)
    const planned = steps(build),
      [snapshot] = planned,
      advances = planned.find(step => step.name === "epoch-index-advances")
    Assert.equal(snapshot.runner, Steps.epochAdvance.runRecordEpochIndices)
    Assert.equal(snapshot.input.snapshotName, LIQYieldScenarioConstants.PreSyndicationEpochSnapshot)
    Assert.ok(planned.indexOf(advances) > planned.findIndex(step => step.runner !== snapshot.runner && step.name.includes("syndicat")))
    Assert.equal(advances.runner, Steps.epochAdvance.runVerifyEpochIndicesAdvanced)
    Assert.equal(advances.input.snapshotName, LIQYieldScenarioConstants.PreSyndicationEpochSnapshot)
    Assert.equal(
      advances.options.timeoutMs,
      Steps.epochAdvance.everyChainAdvanceBudgetMs(Config) + ProtocolTiming.PollDeadlineBufferMs
    )
  } finally { bonder.mockRestore() }
})

test("planning needs the resolved config the epoch-advance ceiling derives from", () => {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() }),
    bonder = jest.spyOn(Steps.registry, "readMockSyndicationBonder").mockReturnValue({})
  try {
    Assert.throws(() => new LIQYieldScenario().plan(build))
  } finally { bonder.mockRestore() }
})

for (const [balance, valid] of [["100.000000000 LIQSOL", true], ["100.000000001 LIQSOL", false]]) {
  test(`the imported shadow verification reads exact asset units: ${balance}`, async () => {
    const ctx = { outputs: new OutputStore(), config: Config, wire: {
      getSysioContract: () => ({ tables: { accounts: { query: async () => ({ rows: [{ balance }] }) } } })
    } }, build = ClusterBuild.forContext(ctx),
      bonder = jest.spyOn(Steps.registry, "readMockSyndicationBonder").mockReturnValue({})
    try {
      new LIQYieldScenario().plan(build)
      const step = steps(build).find(step => step.name === "import-delivered-to-bonder"),
        run = () => step.runner(ctx, step.input, new AbortController().signal)
      if (valid) await run()
      else await Assert.rejects(run())
    } finally { bonder.mockRestore() }
  })
}

// The flow waits for the reservoir to empty, and the operators tick each pool about once a
// minute: one clip at the mock pool's cap has to sell the whole reported yield, which is the
// donation plus whatever staking yield accrued, so the cap must clear the donation with room.
test("one clip at the mock LIQSOL pool's cap sells more than the donated yield", () => {
  const pool = Steps.registry.MockLiqPoolRegistrations.find(row => row.token_code === Constants.LIQSOL_CODENAME),
    clip = BigInt(pool.initial_chain_amount) * BigInt(pool.depth_cap_bps) / WireSyndicationTool.BasisPoints
  Assert.ok(pool.depth_cap_bps <= pool.fee)
  Assert.ok(clip > LIQYieldScenarioConstants.BonusYieldLamports,
    `a clip of ${clip} does not clear the ${LIQYieldScenarioConstants.BonusYieldLamports} donated`)
})

test.each(["syndicate-liq-circulates", "syndication-held-before-bond", "yield-held-before-bond"])(
  "%s waits on its Solana -> depot attestation without pushing traffic: the outpost's backlog report drives Solana",
  async name => {
    const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
      // A shadow supply read for the yield wait; nothing else reaches the depot.
      wire = {
        getSysioContract: () => ({
          tables: { stat: { query: async () => ({ rows: [{ supply: "1.000000000 LIQSOL" }] }) } }
        })
      },
      ctx = {
        wire,
        outputs: new OutputStore(),
        config: { ...Config, clusterPath: "/tmp/unused-unit-cluster", dataPath: "/tmp/unused-unit-wallet" }
      },
      build = ClusterBuild.forContext(ctx),
      spies = [
        jest.spyOn(Steps.registry, "readMockSyndicationBonder").mockReturnValue({}),
        jest.spyOn(WireSyndicationTool, "readHeldEnvelope").mockResolvedValue(undefined),
        jest.spyOn(SolanaFundingTool, "loadKeypair").mockReturnValue({ publicKey: { toBuffer: () => Buffer.alloc(32), toBytes: () => new Uint8Array(32) } }),
        jest.spyOn(SolanaLiqSyndicationTool, "readLiqYieldState").mockResolvedValue({
          liqYieldReported: LIQYieldScenarioConstants.BonusYieldLamports
        }),
        jest.spyOn(StepTools, "pollUntil").mockImplementation(async (label, predicate) => {
          Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
        })
      ],
      states = jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates").mockResolvedValue({}),
      push = jest.spyOn(Steps.contracts.sysio.epoch, "runNotetraffic").mockResolvedValue(undefined)
    try {
      new LIQYieldScenario().plan(build)
      ctx.outputs.set(LIQYieldScenario.LiqYieldStateBeforeKey, { liqYieldReported: 0n })
      const step = steps(build).find(entry => entry.name === name)
      await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /Timed out waiting for/)
      Assert.equal(push.mock.calls.length, 0)
      Assert.equal(states.mock.calls.length, 0)
    } finally {
      ;[...spies, states, push].forEach(spy => spy.mockRestore())
    }
  }
)
