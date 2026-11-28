const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")

const { SlugName } = require("@wireio/sdk-core")
const {
  ClusterBuild,
  ClusterBuildDefaults,
  MinBatchOperatorGroups,
  NodeConfig,
  NodeOwnerTier,
  NodeRole,
  OutputStore,
  ProtocolTiming,
  Steps,
  WireEconomicClockTool
} = require("@wireio/cluster-tool")

const { SlashingScenario } = require("../lib/SlashingScenario.js")
const {
  SlashingScenarioConstants: Constants
} = require("../lib/SlashingScenarioConstants.js")
const {
  SlashingScenarioDisputeSteps: DisputeSteps
} = require("../lib/steps/SlashingScenarioDisputeSteps.js")

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

/** Every step under a build, group or phase, in plan order. */
function allSteps(node) {
  return [...(node.steps ?? []), ...(node.children ?? []).flatMap(allSteps)]
}

/** The contested epoch {@link stagedContext} stages. */
const StagedEpoch = 9

/** A `sysio.msgch::envelopes` row of `chain` at `epochIndex` delivered by `operator`, as the RPC renders it. */
function envelope(chain, epochIndex, operator) {
  return { chain_code: String(SlugName.from(chain)), epoch_index: epochIndex, batch_op_name: operator }
}

/** A build context holding the staged contested epoch, whose `envelopes` read returns `rows`. */
function stagedContext(rows) {
  return {
    outputs: new OutputStore().set(DisputeSteps.ContestedEpochKey, StagedEpoch),
    wire: {
      getSysioContract: () => ({ tables: { envelopes: { query: async () => ({ rows, more: false }) } } })
    }
  }
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
      "SlashNonCanonical",
      "ContestedChainAdvances"
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
    observationName: Constants.DisputePauseObservation,
    keepDueChains: []
  })
  Assert.deepEqual(restartAwait.input, {
    kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
    count: Constants.EconomicEpochsPerObservation,
    observationName: Constants.RelayRestartObservation,
    keepDueChains: []
  })
  Assert.equal(pausedAwait.options.timeoutMs, timeoutMs)
  Assert.equal(restartAwait.options.timeoutMs, timeoutMs)
  Assert.equal(pausedHeld.input.chain, Constants.ContestedChain)
  Assert.equal(restartHeld.input.chain, Constants.ContestedChain)
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
    [
      ...Constants.LosingOperators.map(operator => `${operator}-slashed`),
      "slashed-before-advance",
      "canonical-not-slashed"
    ]
  )
  Assert.deepEqual(
    build.children.map(entry => entry.name).slice(-1),
    ["ContestedChainAdvances"]
  )
})

test("after the resolution, a chkcons moves the contested chain on with no traffic of the flow's own, and the flow ends there", () => {
  const { build } = plannedBuild(),
    steps = child(build, "ContestedChainAdvances").steps,
    [record, due, crank, verify] = steps
  // The resolution records the chain's traffic itself, so the phase pushes no notetraffic.
  Assert.deepEqual(
    steps.map(step => step.name),
    ["record-slashed-operators", "contested-chain-due", "crank-contested-chain", "advanced-without-slash"]
  )
  Assert.ok(!steps.some(step => step.runner === Steps.contracts.sysio.epoch.runNotetraffic))
  Assert.equal(record.runner, DisputeSteps.runRecordSlashedOperators)
  Assert.equal(due.runner, DisputeSteps.runAwaitContestedChainDue)
  Assert.equal(due.options.timeoutMs, Constants.contestedDueDeadlineMs() + Constants.PollDeadlineBufferMs)
  Assert.equal(crank.runner, DisputeSteps.runCrankContestedChain)
  Assert.deepEqual(crank.input.data, { chain_code: Constants.ContestedChainCode })
  Assert.equal(
    Constants.contestedDueDeadlineMs(),
    ProtocolTiming.effectiveEpochsMs(Constants.EpochDurationSec, Constants.ContestedDueEpochBudget)
  )
  Assert.equal(verify.input, null)
})

/** The SLASHED operators the resolution left: the losers. */
const ResolvedSlashed = [...Constants.LosingOperators].sort()

/**
 * A context past the contested epoch at `currentEpoch`, the operators' statuses as `statuses` name
 * them, the SLASHED set recorded before the advances as {@link ResolvedSlashed}.
 */
function advancedContext(currentEpoch, statuses) {
  mock.method(Steps.contracts.sysio.epoch, "readEpochState", async (_ctx, chain) => ({
    chain_code: String(SlugName.from(chain)),
    current_epoch_index: currentEpoch
  }))
  mock.method(DisputeSteps, "readOperator", async (_ctx, label) => ({ account: label, status: statuses[label] }))
  mock.method(DisputeSteps, "readSlashedOperators", async () =>
    Object.entries(statuses)
      .filter(([, status]) => status === "OPERATOR_STATUS_SLASHED")
      .map(([account]) => account)
      .sort()
  )
  return {
    outputs: new OutputStore()
      .set(DisputeSteps.ContestedEpochKey, StagedEpoch)
      .set(DisputeSteps.SlashedOperatorsKey, ResolvedSlashed)
  }
}

/** The statuses after the resolution: the losers SLASHED, the canonical deliverer ACTIVE. */
function resolvedStatuses() {
  return Object.fromEntries([
    ...Constants.LosingOperators.map(operator => [operator, "OPERATOR_STATUS_SLASHED"]),
    [Constants.CanonicalOperator, "OPERATOR_STATUS_ACTIVE"]
  ])
}

/** The named step of the ContestedChainAdvances phase. */
function advancesStep(name) {
  const { build } = plannedBuild()
  return child(build, "ContestedChainAdvances").steps.find(step => step.name === name)
}

test("the advanced-without-slash verify passes past the contested epoch with only the losers slashed", async () => {
  const verify = advancesStep("advanced-without-slash")
  await verify.runner(advancedContext(StagedEpoch + 1, resolvedStatuses()), null, new AbortController().signal)
})

test("the advanced-without-slash verify fails at the contested epoch, or once the advance slashed the canonical deliverer", async () => {
  const verify = advancesStep("advanced-without-slash")
  await Assert.rejects(
    verify.runner(advancedContext(StagedEpoch, resolvedStatuses()), null, new AbortController().signal),
    new RegExp(`still ${StagedEpoch}, not past the contested epoch ${StagedEpoch}`)
  )
  mock.restoreAll()
  await Assert.rejects(
    verify.runner(
      advancedContext(StagedEpoch + 1, { ...resolvedStatuses(), [Constants.CanonicalOperator]: "OPERATOR_STATUS_SLASHED" }),
      null,
      new AbortController().signal
    ),
    new RegExp(`advance past the contested epoch ${StagedEpoch} slashed ${Constants.CanonicalOperator}`)
  )
})

test("the advanced-without-slash verify fails when the advance slashed any other operator", async () => {
  const verify = advancesStep("advanced-without-slash")
  await Assert.rejects(
    verify.runner(
      advancedContext(StagedEpoch + 1, { ...resolvedStatuses(), "batchop.a": "OPERATOR_STATUS_SLASHED" }),
      null,
      new AbortController().signal
    ),
    /slashed batchop\.a/
  )
})

test("each loser's SLASHED read is budgeted from the resolution, which slashes it", () => {
  const { build } = plannedBuild(),
    awaits = child(build, "SlashNonCanonical").steps.filter(
      step => step.runner === DisputeSteps.runAwaitOperatorSlashed
    )
  Assert.deepEqual(
    awaits.map(step => step.input.label),
    [...Constants.LosingOperators]
  )
  awaits.forEach(step =>
    Assert.equal(step.options.timeoutMs, Constants.slashDeadlineMs() + Constants.PollDeadlineBufferMs)
  )
  Assert.equal(
    Constants.slashDeadlineMs(),
    ProtocolTiming.effectiveEpochsMs(Constants.EpochDurationSec, Constants.SlashEpochBudget)
  )
})

/** A build context holding the staged contested epoch, whose contested chain sits at `currentEpoch`. */
function heldContext(currentEpoch) {
  mock.method(Steps.contracts.sysio.epoch, "readEpochState", async (_ctx, chain) => ({
    chain_code: String(SlugName.from(chain)),
    current_epoch_index: currentEpoch
  }))
  return { outputs: new OutputStore().set(DisputeSteps.ContestedEpochKey, StagedEpoch) }
}

test("the slashed-before-advance verify passes while the contested chain sits at the contested epoch", async () => {
  const { build } = plannedBuild(),
    held = child(build, "SlashNonCanonical").steps.find(step => step.name === "slashed-before-advance")
  await held.runner(heldContext(StagedEpoch), null, new AbortController().signal)
})

test("the slashed-before-advance verify fails once the contested chain has advanced", async () => {
  const { build } = plannedBuild(),
    held = child(build, "SlashNonCanonical").steps.find(step => step.name === "slashed-before-advance")
  await Assert.rejects(
    held.runner(heldContext(StagedEpoch + 1), null, new AbortController().signal),
    new RegExp(`moved from the contested epoch ${StagedEpoch} to ${StagedEpoch + 1}`)
  )
})

test("the dispute operators serve only the contested chain, and no schedule is rebuilt mid-run", () => {
  const { build } = plannedBuild(),
    setup = child(build, "SetupDispute"),
    provisioning = child(setup, "ProvisionDisputeOperators"),
    joins = provisioning.children.flatMap(phase =>
      phase.steps.filter(step => step.input.kind === "WireOperatorProvisioningTool.ChainJoinInput")
    )
  Assert.deepEqual(
    joins.map(step => [step.input.label, step.input.chain]),
    Constants.DisputeOperators.map(label => [label, Constants.ContestedChain])
  )
  Assert.equal(typeof Steps.contracts.sysio.epoch.runSchbatchgps, "function")
  Assert.deepEqual(
    allSteps(build).filter(step => step.runner === Steps.contracts.sysio.epoch.runSchbatchgps),
    []
  )
  Assert.notEqual(Constants.RunningChain, Constants.ContestedChain)
})

test("the bootstrap shape is two groups of the dispute operators' size, the depot's floor", () => {
  const { scenario } = plannedBuild()
  Assert.equal(scenario.defaults.operatorsPerEpoch, Constants.DisputeOperators.length)
  Assert.equal(scenario.defaults.batchOpGroups, MinBatchOperatorGroups)
  Assert.equal(scenario.defaults.batchOperatorCount, MinBatchOperatorGroups * Constants.DisputeOperators.length)
})

test("every miss rail runs at the loosest value the contract accepts", () => {
  const { scenario } = plannedBuild()
  Assert.equal(scenario.defaults.terminateMaxConsecutiveMisses, Constants.TerminateMaxConsecutiveMisses)
  Assert.equal(scenario.defaults.terminateMaxPercentMisses24h, ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h)
  Assert.equal(
    scenario.defaults.terminateMinimumPercentSamples,
    ClusterBuildDefaults.MaxTerminateMinimumPercentSamples
  )
})

test("the ACTIVE flips start with headroom before the chain is due, then the next advance is awaited", () => {
  const { build } = plannedBuild(),
    steps = child(child(build, "SetupDispute"), "ReshapeSchedule").steps,
    [headroom] = steps,
    soleGroup = steps[steps.length - 1]
  Assert.deepEqual(
    steps.map(step => step.name),
    [
      "activation-headroom",
      ...Constants.DisputeOperators.map(operator => `force-eligible-${operator}`),
      ...Constants.DisputeOperators.map(operator => `${operator}-active`),
      "sole-active-group"
    ]
  )
  Assert.equal(headroom.runner, DisputeSteps.runAwaitActivationHeadroom)
  Assert.equal(headroom.input, null)
  Assert.equal(
    headroom.options.timeoutMs,
    Constants.activationHeadroomDeadlineMs() + Constants.PollDeadlineBufferMs
  )
  Assert.equal(soleGroup.runner, DisputeSteps.runAwaitSoleActiveGroup)
  Assert.equal(soleGroup.input, null)
  Assert.equal(soleGroup.options.timeoutMs, Constants.groupDeadlineMs() + Constants.PollDeadlineBufferMs)
})

test("the kept-due advances are budgeted one effective contested-chain epoch per group, and one more", () => {
  Assert.equal(Constants.GroupEpochBudget, MinBatchOperatorGroups + 1)
  Assert.equal(
    Constants.groupDeadlineMs(),
    ProtocolTiming.effectiveEpochsMs(Constants.EpochDurationSec, MinBatchOperatorGroups + 1)
  )
})

test("the ACTIVE flips' headroom is a share of the epoch, awaited within its budget", () => {
  Assert.equal(
    Constants.activationHeadroomMs(),
    Constants.EpochDurationSec * Constants.ActivationHeadroomEpochRatio * ProtocolTiming.MsPerSecond
  )
  Assert.ok(Constants.activationHeadroomMs() > 0)
  Assert.ok(Constants.activationHeadroomMs() < Constants.EpochDurationSec * ProtocolTiming.MsPerSecond)
  Assert.equal(
    Constants.activationHeadroomDeadlineMs(),
    ProtocolTiming.effectiveEpochsMs(Constants.EpochDurationSec, Constants.ActivationHeadroomEpochBudget)
  )
})

test("the contested epoch is captured, then its envelope bucket is verified empty, before any delivery", () => {
  const { build } = plannedBuild(),
    inject = child(build, "InjectDivergent"),
    [stage, bucketEmpty] = child(inject, "StageContestedEpoch").steps
  Assert.deepEqual(
    inject.children.map(node => node.name),
    ["StageContestedEpoch", "DivergentDeliveries", "DisputeOpens"]
  )
  Assert.equal(stage.name, "stage-contested-epoch")
  Assert.equal(stage.runner, DisputeSteps.runStageContestedEpoch)
  Assert.deepEqual(stage.options, {})
  Assert.equal(bucketEmpty.name, "contested-bucket-empty")
})

test("the bucket verify passes when only other chains' or epochs' deliveries are retained", async () => {
  const { build } = plannedBuild(),
    [, bucketEmpty] = child(child(build, "InjectDivergent"), "StageContestedEpoch").steps
  await bucketEmpty.runner(
    stagedContext([
      envelope(Constants.ContestedChain, StagedEpoch - 1, "batchop.a"),
      envelope(Constants.RunningChain, StagedEpoch, "batchop.b")
    ]),
    null,
    new AbortController().signal
  )
})

test("the bucket verify fails when the contested epoch already holds a delivery", async () => {
  const { build } = plannedBuild(),
    [, bucketEmpty] = child(child(build, "InjectDivergent"), "StageContestedEpoch").steps
  await Assert.rejects(
    bucketEmpty.runner(
      stagedContext([envelope(Constants.ContestedChain, StagedEpoch, "batchop.a")]),
      null,
      new AbortController().signal
    ),
    /already holds deliveries from \["batchop\.a"\]/
  )
})

test("each dispute operator delivers one divergent envelope, to the contested chain only", () => {
  const { build } = plannedBuild(),
    deliveries = child(child(build, "InjectDivergent"), "DivergentDeliveries"),
    steps = deliveries.children.flatMap(phase => phase.steps)
  Assert.equal(steps.length, Constants.DisputeOperators.length)
  steps.forEach((step, index) => {
    Assert.equal(step.input.chainCode, Constants.ContestedChainCode)
    Assert.equal(step.input.tag, Constants.EnvelopeTags[index])
  })
})
