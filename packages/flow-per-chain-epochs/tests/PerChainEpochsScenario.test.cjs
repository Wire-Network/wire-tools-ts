const Assert = require("node:assert/strict")
const { test } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const { OutpostChainCodename } = require("@wireio/cluster-tool-shared")
const {
  ClusterBuild,
  ClusterBuildDefaults,
  OperatorDaemonTool,
  OutputStore,
  ProtocolTiming,
  Steps,
  WireCollateralTool,
  WireEconomicClockTool,
  WireOperatorProvisioningTool
} = require("@wireio/cluster-tool")

const { PerChainEpochsScenario } = require("../lib/PerChainEpochsScenario.js")
const {
  PerChainEpochsScenarioConstants: Constants
} = require("../lib/PerChainEpochsScenarioConstants.js")
const { PerChainEpochsSteps } = require("../lib/steps/PerChainEpochsSteps.js")

const { SysioOpregChainServiceStatus: ServiceStatus, SysioOpregOperatorstatus: OperatorStatus } =
  SysioContracts

/** The scenario's plan over its own defaults, resolved the way the provider fills them. */
function planned() {
  const scenario = new PerChainEpochsScenario(),
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

test("runs Ethereum and Solana at two distinct durations, neither a multiple of the other", () => {
  const { defaults } = new PerChainEpochsScenario(),
    ethereum = defaults.outpostEpochDurationSec[OutpostChainCodename.ETHEREUM],
    solana = defaults.outpostEpochDurationSec[OutpostChainCodename.SOLANA]
  Assert.equal(ethereum, Constants.EthereumEpochDurationSec)
  Assert.equal(solana, Constants.SolanaEpochDurationSec)
  Assert.notEqual(solana % ethereum, 0)
  Assert.notEqual(ethereum % solana, 0)
  Assert.equal(defaults.epochDurationSec, undefined)
  Assert.equal(defaults.economicEpochDurationSec, Constants.EconomicEpochDurationSec)
  Assert.equal(defaults.batchOperatorCount, Constants.BatchOperatorCount)
  Assert.equal(defaults.adHocCount, Constants.AdHocDaemonCount)
  Assert.equal(defaults.terminateMaxPercentMisses24h, ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h)
  Assert.deepEqual(defaults.requiredBatchOperatorCollateral, [
    WireCollateralTool.createWireRequirement(Constants.MinimumBond)
  ])
})

test("bonds the serving operator above the minimum and the withdrawer below it", () => {
  Assert.ok(Constants.ServingBond >= Constants.MinimumBond)
  Assert.ok(Constants.WithdrawerBond < Constants.MinimumBond)
  Assert.ok(Constants.WithdrawAmount < Constants.WithdrawerBond)
})

test("plans one phase group per claim, so a failure names its phase", () => {
  const { build } = planned()
  Assert.deepEqual(
    build.children.map(group => group.name),
    ["OwnCadence", "ServesOneChain", "LeavesOneChain", "PausesOneChain"]
  )
})

test("the cadence phase checks the configuration, then reads both clocks a window apart and compares them", () => {
  const { build, config } = planned(),
    group = child(build, "OwnCadence"),
    configuration = step(group, "epoch-configuration"),
    [start, window, end, verify] = child(group, "ObserveCadence").steps
  Assert.deepEqual(configuration.input.durations, config.outpostEpochDurationSec)
  Assert.equal(start.runner, WireEconomicClockTool.runRecordClockReading)
  Assert.equal(start.input.observationName, Constants.CadenceStartObservation)
  Assert.equal(window.runner, PerChainEpochsSteps.runAwaitWindowElapsed)
  Assert.deepEqual(window.input, {
    kind: "PerChainEpochsSteps.AwaitWindowElapsedInput",
    fromObservationName: Constants.CadenceStartObservation,
    windowSec: Constants.CadenceWindowSec
  })
  Assert.equal(
    window.options.timeoutMs,
    PerChainEpochsSteps.windowDeadlineMs(Constants.CadenceWindowSec) + ProtocolTiming.PollDeadlineBufferMs
  )
  Assert.equal(end.runner, WireEconomicClockTool.runRecordClockReading)
  Assert.equal(end.input.observationName, Constants.CadenceEndObservation)
  Assert.equal(verify.runner, PerChainEpochsSteps.runVerifyOwnCadence)
  Assert.equal(verify.input.fromObservationName, Constants.CadenceStartObservation)
  Assert.equal(verify.input.toObservationName, Constants.CadenceEndObservation)
})

test("the cadence group names both chains' configured durations", () => {
  const { build, config } = planned(),
    { description } = child(build, "OwnCadence")
  Object.entries(config.outpostEpochDurationSec).forEach(([chain, durationSec]) =>
    Assert.ok(description.includes(`${durationSec} s ${chain}`), description)
  )
})

test("the serving operator joins Ethereum alone in its provisioning phase", () => {
  const { build } = planned(),
    joins = stepsOf(child(child(build, "ServesOneChain"), "ProvisionServingOperator")).filter(
      entry => entry.runner === WireOperatorProvisioningTool.runChainJoin
    )
  Assert.deepEqual(
    joins.map(entry => entry.input.chain),
    [OutpostChainCodename.ETHEREUM]
  )
  joins.forEach(entry => Assert.equal(entry.input.label, Constants.ServingOperatorLabel))
})

test("the serving operator's relay starts before its bond, and it is ACTIVE on Ethereum alone", () => {
  const { build } = planned(),
    admit = child(child(build, "ServesOneChain"), "AdmitServingOperator"),
    names = namesOf(admit),
    relay = step(admit, "start-serving-relay"),
    status = step(admit, "serving-operator-active"),
    memberships = step(admit, "serves-ethereum-only")
  Assert.equal(relay.runner, OperatorDaemonTool.runDaemonStart)
  Assert.equal(status.runner, WireCollateralTool.runVerifyOperatorStatus)
  Assert.equal(status.input.operatorLabel, Constants.ServingOperatorLabel)
  Assert.ok(names.indexOf("start-serving-relay") < names.indexOf("bond-serving-operator"))
  Assert.equal(step(admit, "bond-serving-operator").input.collateral.amount.amount, Constants.ServingBond)
  Assert.equal(status.input.status, OperatorStatus.OPERATOR_STATUS_ACTIVE)
  Assert.deepEqual(memberships.input.expected, { [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING })
})

test("Ethereum seats the serving operator, Solana never does, and its duty is counted on Ethereum", () => {
  const { build, config } = planned(),
    group = child(build, "ServesOneChain"),
    seated = step(group, "seated-on-ethereum"),
    duty = step(group, "ethereum-seat-seconds"),
    unseatedChecks = ["not-seated-on-solana", "still-not-seated-on-solana"]
  Assert.equal(seated.runner, PerChainEpochsSteps.runAwaitOperatorSeated)
  Assert.equal(seated.input.chain, OutpostChainCodename.ETHEREUM)
  Assert.equal(seated.input.budgetEpochs, Constants.ScheduleWindowEpochs)
  unseatedChecks.forEach(name => {
    const unseated = step(group, name)
    Assert.equal(unseated.runner, PerChainEpochsSteps.runVerifyOperatorUnseated)
    Assert.equal(unseated.input.chain, OutpostChainCodename.SOLANA)
  })
  Assert.equal(duty.input.chain, OutpostChainCodename.ETHEREUM)
  Assert.equal(duty.input.sincePeriodName, undefined)
  Assert.equal(
    duty.options.timeoutMs,
    PerChainEpochsSteps.seatSecondsDeadlineMs(config, OutpostChainCodename.ETHEREUM, duty.input.budgetEpochs) +
      ProtocolTiming.PollDeadlineBufferMs
  )
})

test("the operator joins Solana, then leaves Ethereum, and the leave reading follows the leave", () => {
  const { build } = planned(),
    group = child(build, "LeavesOneChain"),
    names = namesOf(group),
    join = step(group, "join-solana"),
    leave = step(group, "leave-ethereum"),
    left = step(group, "left-ethereum"),
    record = step(group, "record-leave"),
    reseated = step(group, "solana-seats-again")
  Assert.equal(join.runner, WireOperatorProvisioningTool.runChainJoin)
  Assert.deepEqual(join.input, {
    kind: "WireOperatorProvisioningTool.ChainJoinInput",
    label: Constants.ServingOperatorLabel,
    chain: OutpostChainCodename.SOLANA
  })
  Assert.equal(leave.runner, WireOperatorProvisioningTool.runChainLeave)
  Assert.deepEqual(leave.input, {
    kind: "WireOperatorProvisioningTool.ChainLeaveInput",
    label: Constants.ServingOperatorLabel,
    chain: OutpostChainCodename.ETHEREUM
  })
  Assert.equal(record.runner, Steps.epochAdvance.runRecordEpochIndices)
  Assert.equal(record.input.snapshotName, Constants.LeaveSnapshot)
  Assert.ok(names.indexOf("leave-ethereum") < names.indexOf("record-leave"))
  Assert.ok(names.indexOf("record-leave") < names.indexOf("solana-seats-again"))
  Assert.deepEqual(left.input.expected, {
    [OutpostChainCodename.ETHEREUM]: ServiceStatus.LEFT,
    [OutpostChainCodename.SOLANA]: ServiceStatus.SERVING
  })
  Assert.equal(reseated.input.sinceSnapshotName, Constants.LeaveSnapshot)
  Assert.equal(reseated.input.chain, OutpostChainCodename.SOLANA)
})

test("Ethereum stops seating the operator through a full rotation before Solana's duty is counted", () => {
  const { build } = planned(),
    group = child(build, "LeavesOneChain"),
    names = namesOf(group),
    closes = step(group, "ethereum-seat-closes"),
    rotation = step(group, "no-new-ethereum-seat"),
    duty = step(group, "solana-seat-seconds")
  Assert.equal(closes.runner, PerChainEpochsSteps.runAwaitOperatorUnseated)
  Assert.equal(rotation.runner, PerChainEpochsSteps.runVerifyUnseatedForRotation)
  Assert.equal(closes.input.chain, OutpostChainCodename.ETHEREUM)
  Assert.equal(rotation.input.chain, OutpostChainCodename.ETHEREUM)
  Assert.ok(rotation.input.budgetEpochs > Constants.RotationMarginEpochs)
  Assert.ok(names.indexOf("ethereum-seat-closes") < names.indexOf("record-solana-only-period"))
  Assert.equal(duty.input.chain, OutpostChainCodename.SOLANA)
  Assert.equal(duty.input.sincePeriodName, Constants.SolanaOnlyDutyPeriod)
  Assert.equal(duty.input.budgetEpochs, rotation.input.budgetEpochs)
})

test("the withdrawer joins Solana alone, stays unscheduled, and serves only Solana", () => {
  const { build } = planned(),
    group = child(build, "PausesOneChain"),
    joins = stepsOf(child(group, "ProvisionWithdrawer")).filter(
      entry => entry.runner === WireOperatorProvisioningTool.runChainJoin
    )
  Assert.deepEqual(
    joins.map(entry => entry.input.chain),
    [OutpostChainCodename.SOLANA]
  )
  Assert.equal(step(group, "withdrawer-unscheduled").runner, WireCollateralTool.runVerifyOperatorStatus)
  Assert.deepEqual(step(group, "withdrawer-unscheduled").input, {
    kind: "WireCollateralTool.VerifyOperatorStatusInput",
    operatorLabel: Constants.WithdrawerLabel,
    status: OperatorStatus.OPERATOR_STATUS_UNKNOWN
  })
  Assert.deepEqual(step(group, "withdrawer-serves-solana-only").input.expected, {
    [OutpostChainCodename.SOLANA]: ServiceStatus.SERVING
  })
})

test("the withdrawal is requested and matures under the Ethereum pause, which is cleared last", () => {
  const { build, config } = planned(),
    group = child(build, "PausesOneChain"),
    names = namesOf(group),
    pause = step(group, "pause-ethereum"),
    unpause = step(group, "unpause-ethereum"),
    record = step(group, "record-withdrawal-request"),
    waits = step(group, "waits-on-solana-alone"),
    matures = step(group, "withdrawal-matures"),
    held = step(group, "ethereum-held"),
    advanced = step(group, "solana-advanced")
  Assert.equal(pause.runner, Steps.contracts.sysio.epoch.runPause)
  Assert.deepEqual(pause.input.data, { chain_code: OutpostChainCodename.ETHEREUM })
  Assert.equal(unpause.runner, Steps.contracts.sysio.epoch.runUnpause)
  Assert.deepEqual(unpause.input.data, { chain_code: OutpostChainCodename.ETHEREUM })
  Assert.ok(names.indexOf("pause-ethereum") < names.indexOf("withdraw"))
  Assert.ok(names.indexOf("record-withdrawal-request") < names.indexOf("withdraw"))
  Assert.ok(names.indexOf("solana-advanced") < names.indexOf("unpause-ethereum"))
  Assert.ok(names.indexOf("unpause-ethereum") < names.indexOf("ethereum-resumes"))
  Assert.equal(record.runner, Steps.epochAdvance.runRecordEpochIndices)
  Assert.equal(record.input.snapshotName, Constants.WithdrawalSnapshot)
  Assert.equal(waits.runner, PerChainEpochsSteps.runVerifyWithdrawalWaits)
  Assert.equal(waits.input.chain, OutpostChainCodename.SOLANA)
  Assert.equal(waits.input.beforeSnapshotName, Constants.WithdrawalSnapshot)
  Assert.equal(matures.input.claim.amount, Constants.WithdrawAmount)
  Assert.equal(matures.options.timeoutMs, WireCollateralTool.remitClaimStepTimeoutMs(config))
  Assert.equal(held.runner, WireEconomicClockTool.runVerifyConsensusHeld)
  Assert.deepEqual(held.input, {
    kind: "WireEconomicClockTool.VerifyConsensusHeldInput",
    chain: OutpostChainCodename.ETHEREUM,
    observationNames: [Constants.PausedStartObservation, Constants.PausedEndObservation]
  })
  Assert.equal(advanced.runner, WireEconomicClockTool.runVerifyConsensusAdvanced)
  Assert.equal(advanced.input.kind, "WireEconomicClockTool.VerifyConsensusAdvancedInput")
  Assert.equal(advanced.input.chain, OutpostChainCodename.SOLANA)
  Assert.equal(advanced.input.fromObservationName, Constants.PausedStartObservation)
  Assert.equal(advanced.input.toObservationName, Constants.PausedEndObservation)
})

test("each phase group's longest Step ceiling is the one the README states", () => {
  const { build } = planned(),
    longest = group =>
      stepsOf(child(build, group))
        .filter(entry => entry.options.timeoutMs != null)
        .reduce((max, entry) => (entry.options.timeoutMs > max.options.timeoutMs ? entry : max))
  Assert.deepEqual(
    ["OwnCadence", "ServesOneChain", "LeavesOneChain"].map(group => {
      const { name, options } = longest(group)
      return [group, name, options.timeoutMs / 1_000]
    }),
    [
      ["OwnCadence", "cadence-window", 780],
      ["ServesOneChain", "ethereum-seat-seconds", 540],
      ["LeavesOneChain", "seated-on-solana", 930]
    ]
  )
})
