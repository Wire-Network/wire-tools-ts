const Assert = require("node:assert/strict")
const { test } = require("node:test")
const { ClusterBuild, WireCollateralTool } = require("@wireio/cluster-tool")
const { SlashingScenario } = require("../lib/SlashingScenario.js")
const {
  SlashingScenarioConstants: Constants
} = require("../lib/SlashingScenarioConstants.js")

/** Compose the real scenario without executing any Step or resolving runtime ports. */
function planned() {
  const scenario = new SlashingScenario(),
    build = ClusterBuild.forContext({}),
    setupName = "SetupDispute"
  scenario.plan(build)
  const setup = build.children.find(child => child.name === setupName)
  Assert.ok(setup)
  const phase = setup.children.find(child => child.name === "ReshapeSchedule")
  Assert.ok(phase)
  return { scenario, steps: phase.steps }
}

test("bootstrap installs the positive WIRE minimum each dispute operator bonds", () => {
  const { scenario } = planned()
  Assert.ok(Constants.DisputeOperatorBondAmount > 0n)
  Assert.deepEqual(scenario.defaults.requiredBatchOperatorCollateral, [
    WireCollateralTool.createWireRequirement(
      Constants.DisputeOperatorBondAmount
    )
  ])
})

for (const operator of Constants.DisputeOperators) {
  test(`${operator} funds, bonds, and verifies live eligibility before scheduling`, () => {
    const { steps } = planned(),
      funding = steps.findIndex(
        step =>
          step.input?.kind === "WireCollateralTool.FundingInput" &&
          step.input.operatorLabel === operator
      ),
      deposit = steps.findIndex(
        step =>
          step.input?.kind === "WireCollateralTool.DepositInput" &&
          step.input.operatorLabel === operator
      ),
      balance = steps.findIndex(
        step =>
          step.input?.kind === "WireCollateralTool.VerifyBalanceRowInput" &&
          step.input.operatorLabel === operator
      ),
      active = steps.findIndex(
        step =>
          step.input?.kind ===
            "SlashingScenarioDisputeSteps.AwaitOperatorActiveInput" &&
          step.input.label === operator
      ),
      schedule = steps.findIndex(step => step.name === "rebuild-groups"),
      collateral = WireCollateralTool.createWireCollateral(
        Constants.DisputeOperatorBondAmount
      )
    Assert.ok(funding >= 0, "the operator must receive real WIRE to bond")
    Assert.ok(
      funding < deposit &&
        deposit < balance &&
        balance < active &&
        active < schedule
    )
    for (const index of [funding, deposit, balance])
      Assert.deepEqual(steps[index].input.collateral, collateral)
    Assert.ok(
      steps.every(
        step =>
          step.input?.kind !== "SlashingScenarioDisputeSteps.ProcessbatchInput"
      )
    )
    Assert.equal(steps[steps.length - 1].name, "sole-active-group")
  })
}
