const Assert = require("node:assert/strict")
const { test } = require("node:test")

const {
  ClusterBuild,
  NodeOwnerTier,
  OutputStore
} = require("@wireio/cluster-tool")

const { SlashingScenario } = require("../lib/SlashingScenario.js")
const {
  SlashingScenarioConstants: Constants
} = require("../lib/SlashingScenarioConstants.js")

test("provisions each Tier-1 voter through a single nodeownreg step", () => {
  const scenario = new SlashingScenario(),
    build = ClusterBuild.forContext({
      outputs: new OutputStore(),
      config: scenario.defaults
    })
  scenario.plan(build)
  const setup = build.children.find(group => group.name === "SetupDispute"),
    provision = setup.children.find(phase => phase.name === "ProvisionVoters"),
    writes = provision.steps.filter(
      step => step.name !== "electorate-registered"
    )
  Assert.equal(writes.length, 4)
  Assert.deepEqual(
    writes.map(step => step.input.account),
    Constants.Tier1ElectorateNames
  )
  for (const step of writes) {
    Assert.equal(
      step.input.kind,
      "SlashingScenarioDisputeSteps.NodeownregInput"
    )
    Assert.equal(step.input.tier, NodeOwnerTier.T1)
  }
})
