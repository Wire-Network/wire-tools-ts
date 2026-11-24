const Assert = require("node:assert/strict")
const { test } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const {
  ClusterBuild,
  OutputStore,
  Steps,
  WireCollateralTool,
  WireEconomicClockTool
} = require("@wireio/cluster-tool")

const { EconomicClockScenario } = require("../lib/EconomicClockScenario.js")
const {
  EconomicClockScenarioConstants: Constants
} = require("../lib/EconomicClockScenarioConstants.js")
const { EconomicClockSteps } = require("../lib/steps/EconomicClockSteps.js")

const { WithdrawalWait } = EconomicClockSteps

/** The scenario's plan over its own defaults, resolved the way the provider fills them. */
function planned() {
  const scenario = new EconomicClockScenario(),
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

test("runs the consensus epoch at its floor and the economic clock at twice that", () => {
  const { defaults } = new EconomicClockScenario()
  Assert.equal(defaults.epochDurationSec, Constants.EpochDurationSec)
  Assert.equal(defaults.economicEpochDurationSec, Constants.EconomicEpochDurationSec)
  Assert.equal(defaults.economicEpochDurationSec, 2 * defaults.epochDurationSec)
  Assert.equal(defaults.producerCount, Constants.ProducerCount)
})

test("plans one phase group per phase, so a failure names its phase", () => {
  const { build } = planned()
  Assert.deepEqual(
    build.children.map(group => group.name),
    ["ClocksIndependent", "WithdrawalWaitsOnBothClocks", "HeldEmissions", "AndonCord"]
  )
})

test("the clock-independence phase observes five economic epochs and asserts over that observation", () => {
  const { build, config } = planned(),
    observe = child(child(build, "ClocksIndependent"), "ObserveClocks"),
    [await_, ...verifies] = observe.steps
  Assert.deepEqual(await_.input, {
    kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
    count: Constants.ClockObservationEpochs,
    observationName: Constants.ClockObservation
  })
  Assert.equal(
    await_.options.timeoutMs,
    WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
      config.economicEpochDurationSec,
      Constants.ClockObservationEpochs
    )
  )
  Assert.deepEqual(
    verifies.map(entry => entry.runner),
    [
      WireEconomicClockTool.runVerifyEconomicGrid,
      EconomicClockSteps.runVerifyConsensusCadence,
      EconomicClockSteps.runVerifyEmissionsPaidPerEconomicEpoch
    ]
  )
  verifies.forEach(entry => Assert.equal(entry.input.observationName, Constants.ClockObservation))
})

test("the producer's pay is recorded, claimed and verified, in that order, for the producer", () => {
  const { build } = planned()
  for (const [group, phase, snapshot] of [
    ["ClocksIndependent", "ClaimProducerPay", Constants.ClockPayClaim],
    ["AndonCord", "ClaimUnderCord", Constants.CordPayClaim]
  ]) {
    const [record, claim, verify] = child(child(build, group), phase).steps
    Assert.equal(record.runner, EconomicClockSteps.runRecordPayClaim)
    Assert.deepEqual(record.input, {
      kind: "EconomicClockSteps.PayClaimInput",
      account: Constants.Producer,
      snapshotName: snapshot
    })
    Assert.equal(claim.runner, Steps.contracts.sysio.system.runClaimpay)
    Assert.deepEqual(claim.input.data, { account_name: Constants.Producer })
    Assert.equal(verify.runner, EconomicClockSteps.runVerifyPayClaimPaid)
    Assert.deepEqual(verify.input, { ...record.input })
  }
})

test("the first withdrawal is requested as an economic epoch opens and held by its economic wait", () => {
  const { build, config } = planned(),
    phase = child(child(build, "WithdrawalWaitsOnBothClocks"), "ConsensusGuardPassesFirst"),
    [epoch, withdraw, eligibility, guard, held, matures, flushed] = phase.steps
  Assert.equal(epoch.input.observationName, Constants.ConsensusFirstObservation)
  Assert.equal(withdraw.runner, WireCollateralTool.runWithdrawal)
  Assert.equal(withdraw.input.operatorLabel, Constants.WithdrawerLabel)
  Assert.equal(withdraw.input.collateral.amount.amount, Constants.WithdrawAmount)
  Assert.equal(eligibility.input.observationName, Constants.ConsensusFirstObservation)
  Assert.equal(eligibility.input.withdrawalName, Constants.ConsensusFirstWithdrawal)
  Assert.equal(guard.input.wait, WithdrawalWait.consensus)
  Assert.equal(
    guard.options.timeoutMs,
    EconomicClockSteps.withdrawalWaitStepTimeoutMs(config, WithdrawalWait.consensus)
  )
  Assert.deepEqual(held.input, {
    kind: "EconomicClockSteps.WithdrawalHeldInput",
    withdrawalName: Constants.ConsensusFirstWithdrawal,
    passed: WithdrawalWait.consensus,
    remitClaim: 0n
  })
  Assert.equal(matures.runner, WireCollateralTool.runVerifyRemitClaim)
  Assert.equal(matures.input.claim.amount, Constants.WithdrawAmount)
  Assert.equal(matures.options.timeoutMs, WireCollateralTool.remitClaimStepTimeoutMs(config))
  Assert.equal(flushed.input.withdrawalName, Constants.ConsensusFirstWithdrawal)
})

test("the second withdrawal is requested under a consensus pause and held by its consensus guard", () => {
  const { build } = planned(),
    phase = child(child(build, "WithdrawalWaitsOnBothClocks"), "EconomicWaitPassesFirst"),
    names = phase.steps.map(entry => entry.name),
    pause = step(phase, "pause-consensus"),
    unpause = step(phase, "unpause-consensus"),
    wait = step(phase, "economic-wait-passes"),
    held = step(phase, "held-by-consensus-guard"),
    matures = step(phase, "economic-first-matures")
  Assert.equal(pause.runner, Steps.contracts.sysio.epoch.runPause)
  Assert.equal(unpause.runner, Steps.contracts.sysio.epoch.runUnpause)
  Assert.ok(names.indexOf("pause-consensus") < names.indexOf("withdraw-economic-first"))
  Assert.ok(names.indexOf("held-by-consensus-guard") < names.indexOf("unpause-consensus"))
  Assert.ok(names.indexOf("unpause-consensus") < names.indexOf("economic-first-matures"))
  Assert.equal(wait.input.wait, WithdrawalWait.economic)
  Assert.equal(held.input.passed, WithdrawalWait.economic)
  Assert.equal(held.input.remitClaim, Constants.WithdrawAmount)
  Assert.equal(matures.input.claim.amount, Constants.MaturedClaimAmount)
})

test("the withdrawer bonds and is verified unscheduled before it withdraws", () => {
  const { build } = planned(),
    bond = child(child(build, "WithdrawalWaitsOnBothClocks"), "BondWithdrawer"),
    unscheduled = step(bond, "withdrawer-unscheduled")
  Assert.deepEqual(unscheduled.input, {
    kind: "EconomicClockSteps.OperatorStatusInput",
    label: Constants.WithdrawerLabel,
    status: SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
  })
})

test("the treasury drains right after an economic epoch opens and refunds right after the hold's last one", () => {
  const { build } = planned(),
    group = child(build, "HeldEmissions"),
    names = stepsOf(group).map(entry => entry.name),
    drain = step(group, "drain-spendable-wire"),
    refund = step(group, "refund-spendable-wire")
  Assert.equal(names[names.indexOf("drain-spendable-wire") - 1], "economic-epoch-before-drain")
  Assert.equal(names[names.indexOf("refund-spendable-wire") - 1], "clocks-run-while-held")
  Assert.equal(names[names.indexOf("refund-spendable-wire") + 1], "held-period-paid")
  Assert.equal(drain.input.holder, Constants.TreasuryHolder)
  Assert.equal(refund.input.holder, Constants.TreasuryHolder)
  Assert.equal(step(group, "create-treasury-holder").input.account, Constants.TreasuryHolder)
  Assert.equal(
    step(group, "opp-round-trip-during-hold").options.timeoutMs,
    Constants.RoundTripOptions.timeoutMs
  )
})

test("the andon cord is pulled, verified throughout the claim, then cleared", () => {
  const { build } = planned(),
    group = child(build, "AndonCord")
  Assert.deepEqual(step(group, "pull-cord").input.data, { reason: Constants.AndonReason })
  Assert.deepEqual(step(group, "clear-cord").input.data, { note: Constants.AndonNote })
  Assert.equal(step(group, "cord-pulled").input.pulled, true)
  Assert.equal(step(group, "cord-still-pulled").input.pulled, true)
  Assert.equal(step(group, "cord-clear").input.pulled, false)
})

test("every observation, withdrawal, snapshot, hold and release is written before a step reads it", () => {
  const { build } = planned(),
    written = new Set()
  for (const entry of stepsOf(build)) {
    const input = entry.input ?? {}
    const reads = [
        ...(input.observationNames ?? []).map(name => `observation:${name}`),
        ...(entry.runner === WireEconomicClockTool.runAwaitEconomicEpochsOpened ||
        entry.runner === WireEconomicClockTool.runRecordClockReading
          ? []
          : input.observationName != null
            ? [`observation:${input.observationName}`]
            : []),
        ...(entry.runner === EconomicClockSteps.runVerifyWithdrawalEligibility || input.withdrawalName == null
          ? []
          : [`withdrawal:${input.withdrawalName}`]),
        ...(entry.runner === EconomicClockSteps.runAwaitEmissionsHeld || input.holdName == null
          ? []
          : [`hold:${input.holdName}`]),
        ...(entry.runner === EconomicClockSteps.runVerifyEmissionsReleased
          ? [`release:${input.releaseName}`]
          : []),
        ...(entry.runner === EconomicClockSteps.runVerifyPayClaimPaid
          ? [`pay:${input.snapshotName}`]
          : []),
        ...(entry.runner === EconomicClockSteps.runVerifyWithdrawalHeld
          ? [`wait:${input.withdrawalName}.${input.passed}`]
          : [])
      ],
      writes = [
        ...(entry.runner === WireEconomicClockTool.runAwaitEconomicEpochsOpened ||
        entry.runner === WireEconomicClockTool.runRecordClockReading
          ? [`observation:${input.observationName}`]
          : []),
        ...(entry.runner === EconomicClockSteps.runVerifyWithdrawalEligibility
          ? [`withdrawal:${input.withdrawalName}`]
          : []),
        ...(entry.runner === EconomicClockSteps.runAwaitEmissionsHeld ? [`hold:${input.holdName}`] : []),
        ...(entry.runner === EconomicClockSteps.runAwaitEmissionsReleased
          ? [`release:${input.releaseName}`]
          : []),
        ...(entry.runner === EconomicClockSteps.runRecordPayClaim ? [`pay:${input.snapshotName}`] : []),
        ...(entry.runner === EconomicClockSteps.runAwaitWithdrawalWaitPassed
          ? [`wait:${input.withdrawalName}.${input.wait}`]
          : [])
      ]
    reads.forEach(name => Assert.ok(written.has(name), `${entry.name} reads ${name} before any step writes it`))
    writes.forEach(name => written.add(name))
  }
})
