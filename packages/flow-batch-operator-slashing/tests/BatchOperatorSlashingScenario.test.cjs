const Assert = require("node:assert/strict")
const { test } = require("node:test")

const {
  BatchOperatorDisputeConstants: Constants
} = require("@wireio/batch-operator-dispute-shared")
const { ClusterBuild } = require("@wireio/cluster-tool")

const {
  BatchOperatorSlashingScenario
} = require("../lib/BatchOperatorSlashingScenario.js")

function childNamed(parent, name) {
  const child = parent.children.find(candidate => candidate.name === name)
  Assert.ok(child, `missing child ${name}`)
  return child
}

test("the slashing scenario preserves the three-candidate topology", () => {
  const build = ClusterBuild.forContext({})
  const scenario = new BatchOperatorSlashingScenario()

  scenario.plan(build)

  Assert.equal(scenario.name, "flow-batch-operator-slashing")
  Assert.equal(
    scenario.defaults.operatorsPerEpoch,
    Constants.DisputeOperatorCount
  )
  Assert.equal(
    childNamed(
      childNamed(build, "InjectDivergent"),
      "CandidateEthereumDeliveries"
    ).steps.length,
    Constants.DisputeOperatorCount
  )
  Assert.deepEqual(
    childNamed(build, "SlashNonCanonical").steps.map(step => step.name),
    [
      "advance-for-slash",
      "dispop.b-slashed",
      "dispop.c-slashed",
      "canonical-not-slashed"
    ]
  )
})
