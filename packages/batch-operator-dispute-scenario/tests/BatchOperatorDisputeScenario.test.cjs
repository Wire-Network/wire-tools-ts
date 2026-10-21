const Assert = require("node:assert/strict")
const { test } = require("node:test")

const {
  ClusterBuild,
  Constants: TestClusterConstants
} = require("@wireio/cluster-tool")
const { NodeOwnerTier } = require("@wireio/opp-typescript-models")
const {
  BatchOperatorDisputeConstants: Constants,
  BatchOperatorDisputeScenario
} = require("../lib/index.js")

const TerminalTieOptions = {
  name: "terminal-tie-test",
  description: "two live operators contest a three-member scheduled group",
  deliveryOperators: [
    Constants.CanonicalOperator,
    Constants.LosingOperators[0]
  ],
  candidateTags: [Constants.EnvelopeTags[0], Constants.EnvelopeTags[1]],
  losingOperators: [Constants.LosingOperators[0]],
  terminatedOperator: Constants.DisputeOperators[2]
}

const ThreeWayOptions = {
  name: "three-way-test",
  description: "three live operators deliver three distinct candidates",
  deliveryOperators: Constants.DisputeOperators,
  candidateTags: Constants.EnvelopeTags,
  losingOperators: Constants.LosingOperators
}

class TestBatchOperatorDisputeScenario extends BatchOperatorDisputeScenario {
  constructor(options) {
    super(options)
  }
}

function newBuild() {
  return ClusterBuild.forContext({})
}

function childNamed(parent, name) {
  const child = parent.children.find(candidate => candidate.name === name)
  Assert.ok(child, `missing child ${name}`)
  return child
}

function configuredGroupSizeStep() {
  const build = newBuild()
  new TestBatchOperatorDisputeScenario(TerminalTieOptions).plan(build)
  const step = childNamed(
    childNamed(build, "SetupDispute"),
    "DegradeLiveGroup"
  ).steps.find(candidate => candidate.name === "configured-group-size")
  Assert.ok(step, "missing configured-group-size step")
  return step
}

test("the shared scenario rejects a delivery operator outside its provisioned roster", () => {
  Assert.throws(
    () =>
      new TestBatchOperatorDisputeScenario({
        ...TerminalTieOptions,
        deliveryOperators: [Constants.CanonicalOperator, "ghost"],
        losingOperators: []
      }).plan(newBuild()),
    /every delivering operator must belong to the provisioned dispute roster/
  )
})

test("the shared scenario rejects duplicate deliveries", () => {
  Assert.throws(
    () =>
      new TestBatchOperatorDisputeScenario({
        ...TerminalTieOptions,
        deliveryOperators: [
          Constants.CanonicalOperator,
          Constants.CanonicalOperator
        ],
        losingOperators: []
      }).plan(newBuild()),
    /delivery operators must be distinct/
  )
})

test("the shared scenario rejects duplicate slashing targets", () => {
  Assert.throws(
    () =>
      new TestBatchOperatorDisputeScenario({
        ...ThreeWayOptions,
        losingOperators: [
          Constants.LosingOperators[0],
          Constants.LosingOperators[0]
        ]
      }).plan(newBuild()),
    /slashing targets must be distinct/
  )
})

test("the shared scenario rejects two deliveries without a terminated scheduled operator", () => {
  Assert.throws(
    () =>
      new TestBatchOperatorDisputeScenario({
        ...TerminalTieOptions,
        terminatedOperator: undefined
      }).plan(newBuild()),
    /a non-terminal dispute must include all three scheduled operators/
  )
})

test("the shared scenario rejects incomplete slashing coverage", () => {
  Assert.throws(
    () =>
      new TestBatchOperatorDisputeScenario({
        ...ThreeWayOptions,
        losingOperators: [Constants.LosingOperators[0]]
      }).plan(newBuild()),
    /slashing targets must be exactly the non-canonical deliverers/
  )
})

test("voter registration uses the canonical ROA inputs including Ethereum identity", () => {
  const build = newBuild()
  new TestBatchOperatorDisputeScenario(TerminalTieOptions).plan(build)
  const steps = childNamed(
    childNamed(build, "SetupDispute"),
    "ProvisionVoters"
  ).steps
  const create = steps.find(step => step.name === "create-voter1")
  const register = steps.find(step => step.name === "register-voter1")

  Assert.deepEqual(create.input, {
    kind: "RoaContractSteps.NewnameduserInput",
    data: {
      account: "voter1",
      pubkey: TestClusterConstants.DEV_K1_PUBLIC_KEY,
      tier: NodeOwnerTier.T1
    }
  })
  Assert.equal(register.input.kind, "RoaContractSteps.NodeownregInput")
  Assert.equal(register.input.data.owner, "voter1")
  Assert.equal(register.input.data.tier, NodeOwnerTier.T1)
  Assert.match(register.input.data.eth_address, /^[0-9a-f]{40}$/)
  Assert.match(register.input.data.eth_pub_key, /^PUB_EM_/)
  Assert.equal(
    register.input.data.wire_pub_key,
    TestClusterConstants.DEV_K1_PUBLIC_KEY
  )
})

test("configured group-size verification accepts three seats and rejects drift", async () => {
  const step = configuredGroupSizeStep()
  const context = operatorsPerEpoch => ({
    wire: {
      async getEpochConfig() {
        return {
          rows: [{ operators_per_epoch: operatorsPerEpoch }],
          more: false
        }
      }
    }
  })
  const signal = new AbortController().signal

  await step.runner(context(3), step.input, signal)
  await Assert.rejects(
    step.runner(context(2), step.input, signal),
    /epochcfg\.operators_per_epoch must remain 3/
  )
})
