const Assert = require("node:assert/strict")
const { test } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const { ClusterBuild, OutputStore, ProtocolTiming, WireCollateralTool } = require("@wireio/cluster-tool")
const { createUniformOutpostEpochDurations } = require("@wireio/cluster-tool-shared")

const { TerminationScenario } = require("../lib/TerminationScenario.js")
const { TerminationSteps } = require("../lib/steps/TerminationSteps.js")
const {
  TerminationScenarioConstants: Constants
} = require("../lib/TerminationScenarioConstants.js")

/** The scenario's plan over its own defaults, resolved the way the runners read them. */
function plannedBuild() {
  const scenario = new TerminationScenario(),
    build = ClusterBuild.forContext({
      outputs: new OutputStore(),
      config: {
        ...scenario.defaults,
        outpostEpochDurationSec: createUniformOutpostEpochDurations(Constants.EpochDurationSec),
        economicEpochDurationSec: Constants.EpochDurationSec,
        economicStartTime: null
      }
    })
  scenario.plan(build)
  return { scenario, build }
}

/** The named child of a group or build. */
function child(node, name) {
  const found = node.children.find(entry => entry.name === name)
  Assert.ok(found, `missing ${name}`)
  return found
}

test("evicts from the missed chain, keeps rotating, then terminates through governance", () => {
  const { build } = plannedBuild()
  Assert.deepEqual(
    build.children.map(node => node.name),
    [
      "ChainHealth",
      "ProvisionOperator",
      "VerifyRegistration",
      "DepositBelowMinimum",
      "DepositToMinimum",
      "AccumulateMisses",
      "EvictFromChain",
      "ContinuedRotation",
      "GovernanceTermination"
    ]
  )
})

test("the doomed operator joins the missed chain only", () => {
  const { build } = plannedBuild(),
    joins = child(build, "ProvisionOperator").children.flatMap(phase =>
      phase.steps.filter(step => step.input.kind === "WireOperatorProvisioningTool.ChainJoinInput")
    )
  Assert.deepEqual(
    joins.map(step => [step.input.label, step.input.chain]),
    [[Constants.DoomedOperatorLabel, Constants.MissedChain]]
  )
  Assert.notEqual(Constants.UnservedChain, Constants.MissedChain)
})

test("the eviction keeps the operator ACTIVE with its whole bond", () => {
  const { build } = plannedBuild(),
    evict = child(build, "EvictFromChain"),
    bond = evict.steps.find(step => step.name === "evicted-operator-keeps-bond")
  Assert.deepEqual(
    evict.steps.map(step => step.name),
    [
      "membership-evicted",
      "eviction-reason-recorded",
      "evicted-operator-stays-active",
      "evicted-operator-keeps-bond"
    ]
  )
  Assert.equal(bond.input.collateral.amount.amount, Constants.BondAmount)
})

test("the miss rails evict at the second missed duty epoch, inside the eviction budget", () => {
  const { scenario } = plannedBuild()
  Assert.equal(scenario.defaults.terminateMaxConsecutiveMisses, Constants.TerminateMaxConsecutiveMisses)
  Assert.equal(scenario.defaults.terminateMinimumPercentSamples, Constants.TerminateMinimumPercentSamples)
  // Two all-missed duty epochs breach the percent rail before the consecutive rail's strict run.
  Assert.ok(Constants.TerminateMinimumPercentSamples <= Constants.TerminateMaxConsecutiveMisses)
})

test("only governance terminates, and the claim pays the bond after it", () => {
  const { build } = plannedBuild(),
    [terminate, ...rest] = child(build, "GovernanceTermination").steps
  Assert.deepEqual(terminate.input, {
    kind: "TerminationSteps.TerminationInput",
    label: Constants.DoomedOperatorLabel,
    reason: Constants.GovernanceTerminationReason
  })
  Assert.equal(terminate.runner, TerminationSteps.runTermination)
  Assert.deepEqual(
    rest.map(step => step.name),
    [
      "termination-row-populated",
      "depot-records-withdraw-remit",
      "depot-balance-emptied",
      "termination-credits-remit-claim",
      "record-wire-before-claim",
      "claimremit-wire",
      "claim-pays-bond",
      "claim-row-cleared"
    ]
  )
})

test("the status checks around the deposits are the shared operator-status verify", () => {
  const { build } = plannedBuild(),
    { SysioOpregOperatorstatus: Status } = SysioContracts,
    below = child(build, "DepositBelowMinimum").steps.find(step => step.name === "below-minimum-stays-unknown"),
    active = child(build, "DepositToMinimum").steps.find(step => step.name === "depot-status-active")
  ;[
    [below, Status.OPERATOR_STATUS_UNKNOWN],
    [active, Status.OPERATOR_STATUS_ACTIVE]
  ].forEach(([step, status]) => {
    Assert.equal(step.runner, WireCollateralTool.runVerifyOperatorStatus)
    Assert.deepEqual(step.input, {
      kind: "WireCollateralTool.VerifyOperatorStatusInput",
      operatorLabel: Constants.DoomedOperatorLabel,
      status
    })
  })
})

test("the rotation ceiling covers every chain's own full window", () => {
  const { build } = plannedBuild(),
    [rotation] = child(build, "ContinuedRotation").steps
  Assert.equal(
    rotation.options.timeoutMs,
    ProtocolTiming.effectiveEpochsMs(Constants.EpochDurationSec, 3 + Constants.RotationFinalEnvelopeEpochs) +
      ProtocolTiming.PollDeadlineBufferMs
  )
})
