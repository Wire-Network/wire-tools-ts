const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")

const { OutpostChainCodename } = require("@wireio/cluster-tool-shared")
const {
  ClusterBuild,
  Constants: ClusterConstants,
  EthereumFundingTool,
  EthereumSyndicationTool,
  NodeConfig,
  NodeRole,
  OutputStore,
  ProtocolTiming,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  WireEconomicClockTool
} = require("@wireio/cluster-tool")

const { DepotPacedEpochsScenario } = require("../lib/DepotPacedEpochsScenario.js")
const {
  DepotPacedEpochsScenarioConstants: Constants
} = require("../lib/DepotPacedEpochsScenarioConstants.js")
const { DepotPacedEpochsSteps } = require("../lib/steps/DepotPacedEpochsSteps.js")

afterEach(() => mock.restoreAll())

const Ethereum = OutpostChainCodename.ETHEREUM,
  Solana = OutpostChainCodename.SOLANA

/** The planned nodes the late-delivery phase reads: a producer and the bootstrap batch operators. */
const PlannedNodes = [
  { role: NodeRole.producer, name: "node_00", batchOperatorLabel: null },
  { role: NodeRole.batch_operator, name: "node_01", batchOperatorLabel: "batchop.a" },
  { role: NodeRole.batch_operator, name: "node_02", batchOperatorLabel: "batchop.b" }
]

/** The scenario's plan over its own defaults, with the node plan stubbed. */
function planned() {
  mock.method(NodeConfig, "plan", () => PlannedNodes)
  const scenario = new DepotPacedEpochsScenario(),
    config = { ...scenario.defaults, economicStartTime: null },
    build = ClusterBuild.forContext({ outputs: new OutputStore(), config })
  scenario.plan(build)
  return { scenario, config, build }
}

/** The named child of a group or build. */
function child(node, name) {
  const found = node.children.find(entry => entry.name === name)
  Assert.ok(found, `missing ${name}`)
  return found
}

/** Every step under a node, in plan order. */
function stepsOf(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(stepsOf)
}

/** The named step under a node. */
function step(node, name) {
  const found = stepsOf(node).find(entry => entry.name === name)
  Assert.ok(found, `missing step ${name}`)
  return found
}

/** The step names under a node, in plan order. */
function namesOf(node) {
  return stepsOf(node).map(entry => entry.name)
}

/** The ceiling of a Step wrapping a poll of `epochs` effective epochs of `chain`. */
function chainCeilingMs(config, chain, epochs) {
  return ProtocolTiming.effectiveEpochsMs(config.outpostEpochDurationSec[chain], epochs) + ProtocolTiming.PollDeadlineBufferMs
}

test("runs Ethereum at 60 s and Solana at 30 s, nine operators, the economic clock at 120 s and the mock import", () => {
  const { defaults } = new DepotPacedEpochsScenario()
  Assert.deepEqual(defaults.outpostEpochDurationSec, { [Ethereum]: 60, [Solana]: 30 })
  Assert.equal(defaults.epochDurationSec, undefined)
  Assert.equal(defaults.economicEpochDurationSec, 120)
  Assert.equal(defaults.batchOperatorCount, 9)
  Assert.equal(defaults.enableMockSyndicationImport, true)
  // The flow's own minimums and the defaults' are the mainnet values.
  Assert.equal(Constants.EthereumEpochDurationSec, 60)
  Assert.equal(Constants.SolanaEpochDurationSec, 30)
})

test("plans one phase group per claim, so a failure names its phase", () => {
  const { build } = planned()
  Assert.deepEqual(
    build.children.map(group => group.name),
    ["IdleChainsStay", "TrafficMakesDue", "MajorityAndLateDelivery"]
  )
})

test("the idle phase settles every chain, then watches the economic clock open epochs with no chain given traffic", () => {
  const { build, config } = planned(),
    group = child(build, "IdleChainsStay"),
    settle = child(group, "SettleIdle").steps,
    [start, window, end, verify] = child(group, "ObserveIdle").steps,
    epochs = DepotPacedEpochsSteps.idleEconomicEpochs(config)
  Assert.deepEqual(
    settle.map(entry => entry.input.chain),
    [Ethereum, Solana]
  )
  settle.forEach(entry => {
    Assert.equal(entry.runner, DepotPacedEpochsSteps.runAwaitDecidedAndIdle)
    Assert.equal(
      entry.options.timeoutMs,
      Steps.epochAdvance.epochAdvanceBudgetMs(config, entry.input.chain) + ProtocolTiming.PollDeadlineBufferMs
    )
  })
  Assert.equal(start.runner, DepotPacedEpochsSteps.runRecordOppStreams)
  Assert.equal(start.input.snapshotName, Constants.IdleStartStreams)
  Assert.equal(window.runner, WireEconomicClockTool.runAwaitEconomicEpochsOpened)
  Assert.deepEqual(window.input, {
    kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
    count: epochs,
    observationName: Constants.IdleWindowObservation,
    keepDueChains: []
  })
  Assert.equal(
    window.options.timeoutMs,
    WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(config.economicEpochDurationSec, epochs)
  )
  Assert.equal(end.runner, DepotPacedEpochsSteps.runRecordOppStreams)
  Assert.equal(end.input.snapshotName, Constants.IdleEndStreams)
  Assert.equal(verify.runner, DepotPacedEpochsSteps.runVerifyIdle)
  Assert.deepEqual(verify.input, {
    kind: "DepotPacedEpochsSteps.VerifyIdleInput",
    observationName: Constants.IdleWindowObservation,
    fromSnapshotName: Constants.IdleStartStreams,
    toSnapshotName: Constants.IdleEndStreams
  })
})

test("the holders are prepared once: liqETH for the whole burst, and the redeemer linked to the imported LIQSOL", () => {
  const { build } = planned(),
    prepare = child(child(build, "TrafficMakesDue"), "PrepareHolders"),
    burstWei = BigInt(Constants.SyndicationCount) * Constants.SyndicationAmountWei
  Assert.deepEqual(namesOf(prepare), [
    "create-holder-wallet",
    "fund-holder-wallet",
    "deposit-eth",
    "approve-pool",
    "create-redeemer",
    "link-redeemer"
  ])
  Assert.equal(step(prepare, "create-holder-wallet").runner, EthereumFundingTool.runCreateWallet)
  Assert.equal(
    step(prepare, "fund-holder-wallet").input.balanceWei,
    burstWei + Constants.DepositHeadroomWei + Constants.HolderGasWei
  )
  // The deposit mints liqETH at the liqETH rate, under one per ETH, so it carries headroom.
  Assert.equal(step(prepare, "deposit-eth").input.amountWei, burstWei + Constants.DepositHeadroomWei)
  Assert.ok(Constants.DepositHeadroomWei > 0n)
  Assert.equal(step(prepare, "approve-pool").input.amount, burstWei)
  Assert.equal(step(prepare, "approve-pool").input.walletName, Constants.HolderWalletName)
  Assert.deepEqual(step(prepare, "create-redeemer").input, {
    kind: "AccountSteps.CreateKeyedInput",
    account: Constants.RedeemerAccount,
    publicKey: ClusterConstants.DEV_K1_PUBLIC_KEY,
    creator: "sysio"
  })
  Assert.equal(step(prepare, "link-redeemer").runner, SyndicationUserSteps.runLinkSolanaKey)
  Assert.deepEqual(step(prepare, "link-redeemer").input, {
    kind: "SyndicationUserSteps.LinkSolanaKeyInput",
    account: Constants.RedeemerAccount,
    keypairName: Steps.registry.MockSyndicationBonderLabel
  })
})

test("the Ethereum burst is recorded against, made of separate syndications, then timed and counted", () => {
  const { build, config } = planned(),
    burst = child(child(build, "TrafficMakesDue"), "EthereumBurst"),
    syndications = stepsOf(burst).filter(entry => entry.runner === EthereumSyndicationTool.runSyndicate)
  Assert.deepEqual(namesOf(burst), [
    "record-before-ethereum",
    "syndicate-1",
    "syndicate-2",
    "syndicate-3",
    "ethereum-due",
    "ethereum-backlog-reported",
    "ethereum-advances-when-due",
    "ethereum-idle-again",
    "burst-in-one-epoch"
  ])
  Assert.equal(step(burst, "record-before-ethereum").input.snapshotName, Constants.BeforeEthereumTraffic)
  Assert.equal(syndications.length, Constants.SyndicationCount)
  syndications.forEach(entry => Assert.equal(entry.input.amount, Constants.SyndicationAmountWei))
  const due = step(burst, "ethereum-due"),
    advance = step(burst, "ethereum-advances-when-due")
  Assert.equal(due.runner, DepotPacedEpochsSteps.runAwaitChainDue)
  Assert.equal(due.input.chain, Ethereum)
  Assert.equal(due.options.timeoutMs, chainCeilingMs(config, Ethereum, Constants.DueBudgetEpochs))
  Assert.equal(step(burst, "ethereum-backlog-reported").runner, DepotPacedEpochsSteps.runVerifyBacklogReports)
  Assert.equal(advance.runner, DepotPacedEpochsSteps.runAwaitDueAdvance)
  Assert.deepEqual(advance.input, {
    kind: "DepotPacedEpochsSteps.AwaitDueAdvanceInput",
    chain: Ethereum,
    beforeSnapshotName: Constants.BeforeEthereumTraffic
  })
  Assert.equal(advance.options.timeoutMs, chainCeilingMs(config, Ethereum, Constants.AdvanceBudgetEpochs))
  Assert.deepEqual(step(burst, "burst-in-one-epoch").input, {
    kind: "DepotPacedEpochsSteps.VerifyBurstInOneEpochInput",
    walletName: Constants.HolderWalletName,
    count: Constants.SyndicationCount
  })
})

test("the Solana desyndication is queued on the depot, then Solana alone is timed", () => {
  const { build, config } = planned(),
    phase = child(child(build, "TrafficMakesDue"), "SolanaDesyndication"),
    desyndicate = step(phase, "desyndicate-liqsol"),
    advance = step(phase, "solana-advances-when-due")
  Assert.deepEqual(namesOf(phase), [
    "record-before-solana",
    "desyndicate-liqsol",
    "solana-due",
    "solana-advances-when-due"
  ])
  Assert.equal(desyndicate.runner, Steps.contracts.sysio.synd.runQuotedDesyndicate)
  Assert.deepEqual(desyndicate.input.data, {
    holder: Constants.RedeemerAccount,
    quantity: SyndicationScenario.quantity(Constants.DesyndicationAmount)
  })
  Assert.equal(step(phase, "solana-due").input.chain, Solana)
  Assert.equal(step(phase, "solana-due").options.timeoutMs, chainCeilingMs(config, Solana, Constants.DueBudgetEpochs))
  Assert.deepEqual(advance.input, {
    kind: "DepotPacedEpochsSteps.AwaitDueAdvanceInput",
    chain: Solana,
    beforeSnapshotName: Constants.BeforeSolanaTraffic
  })
})

test("the first batch operator is stopped once next on duty, and restarted only after the next epoch opens", () => {
  const { build, config } = planned(),
    group = child(build, "MajorityAndLateDelivery"),
    [, member] = PlannedNodes,
    memberSteps = ["member-next-on-duty", "majority-decides", "late-delivery", "books-credit-member"]
  Assert.deepEqual(namesOf(group), [
    "member-next-on-duty",
    "stop-member-relay",
    "majority-decides",
    "next-epoch-opens",
    "restart-member-relay",
    "late-delivery",
    "books-credit-member"
  ])
  memberSteps.forEach(name =>
    Assert.deepEqual(step(group, name).input, {
      kind: "DepotPacedEpochsSteps.MemberInput",
      chain: Ethereum,
      label: member.batchOperatorLabel
    })
  )
  Assert.equal(step(group, "stop-member-relay").runner, Steps.processes.nodeop.runStop)
  Assert.equal(step(group, "stop-member-relay").input.nodeName, member.name)
  Assert.equal(step(group, "restart-member-relay").runner, Steps.processes.nodeop.runStart)
  Assert.equal(step(group, "restart-member-relay").input.nodeName, member.name)
  Assert.equal(step(group, "next-epoch-opens").runner, DepotPacedEpochsSteps.runAwaitNextEpochOpened)
  Assert.equal(
    step(group, "late-delivery").options.timeoutMs,
    chainCeilingMs(config, Ethereum, Constants.LateDeliveryBudgetEpochs)
  )
  Assert.equal(
    step(group, "books-credit-member").options.timeoutMs,
    chainCeilingMs(config, Ethereum, Constants.BooksClosingBudgetEpochs)
  )
})

test("the burst and the desyndication are sized to the outposts' and the pair's minimums", () => {
  Assert.ok(Constants.SyndicationCount >= 2, "a burst needs at least two messages")
  // 0.005 liqETH: the Ethereum outpost's syndication minimum.
  Assert.ok(Constants.SyndicationAmountWei >= 5_000_000_000_000_000n)
  // 0.05 LIQSOL: the pair's desyndication minimum.
  Assert.ok(Constants.DesyndicationAmount >= 50_000_000n)
  Assert.ok(Constants.DesyndicationAmount <= BigInt(Steps.registry.MockSyndicationImportAmount))
})
