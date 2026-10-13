const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ClusterBuild, OutputStore, EthereumLadderImportKey, WireSyndicationTool, SyndicationScenario } = require("@wireio/cluster-tool")
const { EthereumDeploymentKind } = require("@wireio/cluster-tool-shared")
const { EthereumGoLiveScenario } = require("../lib/EthereumGoLiveScenario.js")
const { EthereumGoLiveScenarioConstants: Constants } = require("../lib/EthereumGoLiveScenarioConstants.js")
afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

const credits = [
  { pubkey: "02" + "aa".repeat(32), amount: "5000000000" },
  { pubkey: "03" + "bb".repeat(32), amount: "3000000000" }
]

test("opts into the ladder deployment and plans the reconciliation before the sweep", () => {
  const scenario = new EthereumGoLiveScenario()
  Assert.equal(scenario.defaults.ethereumDeployment, EthereumDeploymentKind.ladder)
  const build = ClusterBuild.forContext({ outputs: new OutputStore(), config: {} })
  scenario.plan(build)
  const names = steps(build).map(step => step.name)
  Assert.deepEqual(names, [
    "pool-depot-booked-agree",
    "imported-positions-parked",
    "provision-staker-account",
    "link-staker-ethereum-key",
    "parked-credit-swept"
  ])
})

test("every imported credit must be parked with its balance", async () => {
  const ctx = { outputs: new OutputStore() }
  ctx.outputs.set(EthereumLadderImportKey, { credits })
  mock.method(WireSyndicationTool, "readParked", async (_ctx, _token, _kind, pubkey) =>
    pubkey === credits[0].pubkey ? { balance: credits[0].amount } : undefined
  )
  await Assert.rejects(() => EthereumGoLiveScenario.assertCreditsParked(ctx), /no parked row/)
  mock.method(WireSyndicationTool, "readParked", async (_ctx, _token, _kind, pubkey) => ({
    balance: credits.find(credit => credit.pubkey === pubkey).amount
  }))
  await EthereumGoLiveScenario.assertCreditsParked(ctx)
})

test("the sweep is proven by the parked row vanishing AND the balance landing", async () => {
  const ctx = { outputs: new OutputStore() }
  ctx.outputs.set(EthereumLadderImportKey, { credits })
  mock.method(WireSyndicationTool, "readParked", async () => undefined)
  const reads = []
  mock.method(SyndicationScenario, "readBalance", async (_ctx, account, symbol) => {
    reads.push([account, symbol])
    return BigInt(credits[Constants.SweptStakerIndex].amount)
  })
  await EthereumGoLiveScenario.assertCreditSwept(ctx)
  Assert.deepEqual(reads, [[Constants.StakerAccount, Constants.LiqTokenCodename]])
  Assert.equal(EthereumGoLiveScenario.sweptCredit(ctx), credits[Constants.SweptStakerIndex])
})
