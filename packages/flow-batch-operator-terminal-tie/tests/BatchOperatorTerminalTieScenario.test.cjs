const Assert = require("node:assert/strict")
const { test } = require("node:test")

const { ClusterBuild } = require("@wireio/cluster-tool")
const {
  BatchOperatorDisputeConstants: Constants
} = require("@wireio/batch-operator-dispute-scenario")

const {
  BatchOperatorTerminalTieScenario
} = require("../lib/BatchOperatorTerminalTieScenario.js")

function childNamed(parent, name) {
  const child = parent.children.find(candidate => candidate.name === name)
  Assert.ok(child, `missing child ${name}`)
  return child
}

test("the terminal-tie scenario keeps three configured seats but plans two candidates", () => {
  const build = ClusterBuild.forContext({})
  const scenario = new BatchOperatorTerminalTieScenario()

  scenario.plan(build)

  Assert.equal(scenario.name, "flow-batch-operator-terminal-tie")
  Assert.equal(
    scenario.defaults.operatorsPerEpoch,
    Constants.DisputeOperatorCount
  )
  Assert.deepEqual(
    childNamed(childNamed(build, "SetupDispute"), "DegradeLiveGroup").steps.map(
      step => step.name
    ),
    ["terminate-dispop.c", "dispop.c-terminated", "configured-group-size"]
  )
  const disputeStep = childNamed(
    childNamed(build, "InjectDivergent"),
    "DisputeOpens"
  ).steps.find(step => step.name === "dispute-opens")
  Assert.ok(disputeStep)
  Assert.equal(disputeStep.input.expectedCandidateCount, 2)
  Assert.deepEqual(
    childNamed(build, "SlashNonCanonical").steps.map(step => step.name),
    ["advance-for-slash", "dispop.b-slashed", "canonical-not-slashed"]
  )
})
