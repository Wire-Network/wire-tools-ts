const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")

const {
  ClusterBuild,
  NodeConfig,
  NodeOwnerTier,
  NodeRole,
  OutputStore,
  Steps,
  WireEconomicClockTool
} = require("@wireio/cluster-tool")

const { SlashingScenario } = require("../lib/SlashingScenario.js")
const {
  SlashingScenarioConstants: Constants
} = require("../lib/SlashingScenarioConstants.js")

afterEach(() => mock.restoreAll())

/** The planned nodes the relay restart reads: a producer and the bootstrap batch operators. */
const PlannedNodes = [
  { role: NodeRole.producer, name: "node-00", batchOperatorLabel: null },
  { role: NodeRole.batch_operator, name: "node-01", batchOperatorLabel: "batchop.a" },
  { role: NodeRole.batch_operator, name: "node-02", batchOperatorLabel: "batchop.b" },
  { role: NodeRole.batch_operator, name: "node-03", batchOperatorLabel: "batchop.c" }
]

/** The relay nodes of {@link PlannedNodes}. */
const Relays = PlannedNodes.filter(node => node.role === NodeRole.batch_operator)

/** The scenario's plan over its own defaults, with the node plan stubbed. */
function plannedBuild() {
  const scenario = new SlashingScenario(),
    plan = mock.method(NodeConfig, "plan", () => PlannedNodes),
    build = ClusterBuild.forContext({
      outputs: new OutputStore(),
      config: scenario.defaults
    })
  scenario.plan(build)
  return { scenario, build, plan }
}

/** The named child of a group or build. */
function child(node, name) {
  const found = node.children.find(entry => entry.name === name)
  Assert.ok(found, `missing ${name}`)
  return found
}

test("provisions each Tier-1 voter through a single nodeownreg step", () => {
  const { build } = plannedBuild(),
    setup = child(build, "SetupDispute"),
    provision = child(setup, "ProvisionVoters"),
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

test("the economic-clock phases run while the dispute is open: after it opens, before the vote", () => {
  const { build } = plannedBuild()
  Assert.deepEqual(
    build.children.map(group => group.name),
    [
      "SetupDispute",
      "InjectDivergent",
      "EconomicClockDuringDispute",
      "VoteAndResolve",
      "SlashNonCanonical"
    ]
  )
})

test("every relay is stopped, then every relay restarted, by its planned node", () => {
  const { build, scenario, plan } = plannedBuild(),
    group = child(build, "EconomicClockDuringDispute"),
    stops = child(group, "StopRelays").steps,
    starts = child(group, "StartRelays").steps
  Assert.equal(plan.mock.calls[0].arguments[0], scenario.defaults)
  Assert.deepEqual(
    stops.map(step => step.input),
    Relays.map(node => ({ kind: "NodeopProcessSteps.StopInput", nodeName: node.name }))
  )
  Assert.deepEqual(
    starts.map(step => step.input),
    Relays.map(node => ({ kind: "NodeopProcessSteps.StartInput", nodeName: node.name }))
  )
  stops.forEach(step => {
    Assert.equal(step.runner, Steps.processes.nodeop.runStop)
    Assert.equal(step.options.timeoutMs, Constants.RelayStopTimeoutMs)
  })
  starts.forEach(step => {
    Assert.equal(step.runner, Steps.processes.nodeop.runStart)
    Assert.equal(step.options.timeoutMs, Constants.RelayStartTimeoutMs)
  })
})

test("the economic clock is observed before and after the restart against one held consensus epoch", () => {
  const { build } = plannedBuild(),
    group = child(build, "EconomicClockDuringDispute"),
    [pausedAwait, pausedHeld] = child(group, "EconomicClockWhilePaused").steps,
    [restartAwait, restartHeld] = child(group, "EconomicClockAfterRelayRestart").steps,
    timeoutMs = WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
      Constants.EconomicEpochDurationSec,
      Constants.EconomicEpochsPerObservation
    )
  Assert.deepEqual(pausedAwait.input, {
    kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
    count: Constants.EconomicEpochsPerObservation,
    observationName: Constants.DisputePauseObservation
  })
  Assert.deepEqual(restartAwait.input, {
    kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
    count: Constants.EconomicEpochsPerObservation,
    observationName: Constants.RelayRestartObservation
  })
  Assert.equal(pausedAwait.options.timeoutMs, timeoutMs)
  Assert.equal(restartAwait.options.timeoutMs, timeoutMs)
  Assert.deepEqual(pausedHeld.input.observationNames, [Constants.DisputePauseObservation])
  Assert.deepEqual(restartHeld.input.observationNames, [
    Constants.DisputePauseObservation,
    Constants.RelayRestartObservation
  ])
  for (const step of [pausedHeld, restartHeld]) {
    Assert.equal(step.runner, WireEconomicClockTool.runVerifyConsensusHeld)
  }
})

test("the dispute's assertions stay in place around the new phases", () => {
  const { build } = plannedBuild()
  Assert.deepEqual(
    child(child(build, "InjectDivergent"), "DisputeOpens").steps.map(step => step.name),
    ["dispute-opens", "epoch-paused"]
  )
  Assert.deepEqual(
    child(build, "VoteAndResolve").steps.map(step => step.name),
    [
      ...Constants.Tier1VoterNames.map(voter => `vote-${voter}`),
      "dispute-resolves",
      "epoch-unpauses"
    ]
  )
  Assert.deepEqual(
    child(build, "SlashNonCanonical").steps.map(step => step.name),
    [...Constants.LosingOperators.map(operator => `${operator}-slashed`), "canonical-not-slashed"]
  )
})
