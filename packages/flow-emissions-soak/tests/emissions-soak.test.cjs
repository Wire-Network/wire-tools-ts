const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { EthereumDeploymentKind } = require("@wireio/cluster-tool-shared")
const {
  ClusterBuild,
  EthereumLadderImportKey,
  EthereumPreLaunchSteps,
  OutputStore,
  Steps
} = require("@wireio/cluster-tool")
const { EmissionsSoakScenario } = require("../lib/EmissionsSoakScenario.js")
const { EmissionsSoakScenarioConstants: Constants } = require("../lib/EmissionsSoakScenarioConstants.js")
const { EmissionsSoakScenarioSteps } = require("../lib/steps/EmissionsSoakScenarioSteps.js")
afterEach(() => mock.restoreAll())

const signal = new AbortController().signal

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** A derived ladder import seeding each claimant `atomic[i]` WIRE, keyed by its own address. */
function importSeeding(atomic) {
  return {
    credits: [],
    importseed: [
      {
        chain: "CHAIN_KIND_EVM",
        credits: Constants.claimants().map((claimant, index) => ({
          native_address: EthereumPreLaunchSteps.actorWallet(claimant.actorIndex).address.slice(2).toLowerCase(),
          wire_atomic: atomic[index].toString()
        }))
      }
    ]
  }
}

test("bootstraps a ladder cluster and claims for every pre-launch buyer", () => {
  Assert.equal(new EmissionsSoakScenario().defaults.ethereumDeployment, EthereumDeploymentKind.ladder)
  const claimants = Constants.claimants()
  Assert.equal(claimants.length, EthereumPreLaunchSteps.BuyerCount)
  Assert.deepEqual(
    claimants.map(claimant => claimant.actorIndex),
    claimants.map((_, index) => EthereumPreLaunchSteps.buyerActorIndex(index))
  )
  Assert.equal(new Set(claimants.map(claimant => claimant.wireAccount)).size, claimants.length)
})

test("plans no import of its own, and one link per claimant with the buyer's own key", () => {
  const build = ClusterBuild.forContext({ outputs: new OutputStore(), config: {} })
  new EmissionsSoakScenario().plan(build)
  const planned = steps(build),
    links = planned.filter(step => step.runner === Steps.ethereumLadderImport.runLinkActor)
  Assert.deepEqual(
    links.map(step => step.input),
    Constants.claimants().map(claimant => ({
      kind: "EthereumLadderImportSteps.LinkActorInput",
      actorIndex: claimant.actorIndex,
      account: claimant.wireAccount
    }))
  )
  Assert.ok(!planned.some(step => /^import-/.test(step.name)), "the flow must not import a dclaim seed")
})

test("the pre-fund is exactly the claimants' seeded credits", async () => {
  const ctx = { outputs: new OutputStore() }
  ctx.outputs.set(EthereumLadderImportKey, importSeeding([20_000_000_000_000n, 19_687_500_000_000n]))
  const transfer = mock.method(Steps.contracts.sysio.token, "runTransfer", async () => {})
  const step = EmissionsSoakScenarioSteps.planPrefundDclaim(null, "prefund", "prefund", {}, Constants.claimants())
  await step.runner(ctx, step.input, signal)
  const [, input] = transfer.mock.calls[0].arguments
  Assert.equal(input.data.to, "sysio.dclaim")
  Assert.equal(input.data.quantity, "39687.500000000 WIRE")
})

test("a claimant the import did not seed is refused", () => {
  const ctx = { outputs: new OutputStore() },
    [first, second] = Constants.claimants()
  ctx.outputs.set(EthereumLadderImportKey, {
    credits: [],
    importseed: [{ chain: "CHAIN_KIND_EVM", credits: importSeeding([1n, 1n]).importseed[0].credits.slice(0, 1) }]
  })
  Assert.equal(EmissionsSoakScenarioSteps.seededAtomic(ctx, first), 1n)
  Assert.throws(() => EmissionsSoakScenarioSteps.seededAtomic(ctx, second), /no dclaim credit/)
})
