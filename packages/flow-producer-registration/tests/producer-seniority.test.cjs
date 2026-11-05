const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  ClusterBuild,
  OutputStore,
  ProducerTier,
  ProducerTierShift,
  ProtocolTiming
} = require("@wireio/cluster-tool")
const {
  ProducerRegistrationScenario
} = require("../lib/ProducerRegistrationScenario.js")
const {
  ProducerRegistrationScenarioConstants: Constants
} = require("../lib/ProducerRegistrationScenarioConstants.js")

const account = "prodtest"
const otherProducer = "produceraaaa"
const registrationOrder = 3
const earnedSeniority = 72
const signal = new AbortController().signal
afterEach(() => mock.timers.reset())

/** Every step of a planned tree, in registration order. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** The scenario's planned tree. */
function plannedBuild() {
  const build = ClusterBuild.forContext({
    outputs: new OutputStore(),
    config: { epochDurationSec: Constants.EpochDurationSec }
  })
  new ProducerRegistrationScenario().plan(build)
  return build
}

/** The first step the scenario plans under `name`. */
function plannedStep(name) {
  return steps(plannedBuild()).find(step => step.name === name)
}

/** Every step of the scenario's phase `name`, in run order. */
function plannedPhase(name) {
  return steps(plannedBuild().children.find(phase => phase.name === name))
}

/** A `rank_score` in `tier`, rendered the way the RPC renders a uint64. */
function rankScore(tier) {
  return (BigInt(tier) << ProducerTierShift).toString()
}

/** The flow producer's `sysio::producers` row: healthy, registered, no seniority yet. */
function producerRow(overrides = {}) {
  return {
    owner: account,
    rank_score: rankScore(ProducerTier.healthy),
    is_active: true,
    consecutive_missed_rounds: 0,
    is_demoted: false,
    service_sec: 0,
    registration_seq: registrationOrder,
    ...overrides
  }
}

/** The row once its node stopped and the misses demoted it. */
function demotedRow(overrides = {}) {
  return producerRow({
    rank_score: rankScore(ProducerTier.demoted),
    consecutive_missed_rounds: Constants.MaxConsecutiveMissedRounds,
    is_demoted: true,
    ...overrides
  })
}

/** Outputs holding the registration order the registration verify records. */
function recordedOutputs() {
  return new OutputStore().set(Constants.RegistrationOrder, registrationOrder)
}

/** The key store a step resolves the flow producer's account through. */
const keyStore = {
  assertOperator: label => {
    Assert.equal(label, Constants.ProducerLabel)
    return { account }
  }
}

/** A context whose producers reads answer with `row`. */
function context(row, outputs = new OutputStore()) {
  return {
    outputs,
    keyStore,
    wire: { getProducers: async () => ({ rows: [row] }) }
  }
}

/** The head block at the mocked clock's time: block 1 at time 0, one per block interval. */
function headBlock() {
  return 1 + Math.floor(Date.now() / ProtocolTiming.BlockIntervalMs)
}

/**
 * A context over a chain whose head advances with the mocked clock. `producerAt(block)` names
 * each block's producer and `rowAt(block)` is the flow producer's row in the state at that head,
 * so a row can change a block after the event it accounts for, as `onblock` makes it.
 * `seniorityReads` collects the `service_sec` of every producers read.
 */
function chainContext(producerAt, rowAt) {
  const seniorityReads = []
  return {
    seniorityReads,
    ctx: {
      outputs: new OutputStore(),
      keyStore,
      wire: {
        getInfo: async () => ({
          head_block_num: headBlock(),
          head_block_producer: producerAt(headBlock())
        }),
        getProducers: async () => {
          const row = rowAt(headBlock())
          seniorityReads.push(row.service_sec)
          return { rows: [row] }
        }
      }
    }
  }
}

const run = (step, ctx) => step.runner(ctx, step.input, signal)

/**
 * Run `stepList` in order under a mocked clock, advancing it one poll interval whenever the run
 * waits, so polls sleep and reach their deadlines without real time passing.
 */
async function runPolled(stepList, ctx) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  let outcome = null
  stepList
    .reduce((previous, step) => previous.then(() => run(step, ctx)), Promise.resolve())
    .then(
      () => (outcome = { failed: false }),
      error => (outcome = { failed: true, error })
    )
  while (outcome == null) {
    await new Promise(resolve => setImmediate(resolve))
    mock.timers.tick(Constants.PollIntervalMs)
  }
  if (outcome.failed) throw outcome.error
}

test("the flow installs the shipped seniority defaults around its own demotion threshold", () => {
  Assert.deepEqual(plannedStep("setscorecfg").input.data, {
    weights: Constants.ScoreConfig
  })
  Assert.deepEqual(Constants.ScoreConfig, {
    snapshot_weight: 259_200,
    relay_weight: 0,
    api_weight: 0,
    benchmark_weight: 0,
    max_consecutive_missed_rounds: 3,
    snapshot_target_attestations: 1,
    min_blocks_per_round: 0,
    miss_penalty_sec: 604_800,
    seniority_base_sec: 604_800
  })
})

test("registration records the producer's order and requires that it holds no seniority", async () => {
  const step = plannedStep("registration-scores-the-producer"),
    ctx = context(producerRow())
  await run(step, ctx)
  Assert.equal(ctx.outputs.assert(Constants.RegistrationOrder), registrationOrder)

  await Assert.rejects(
    run(step, context(producerRow({ service_sec: 3_600 }))),
    /3600s of seniority where it should hold none/
  )
  await Assert.rejects(
    run(step, context(producerRow({ registration_seq: "0" }))),
    /no registration order/
  )
})

test("entering the schedule waits for the produced round's seniority, which lands a block after the producer's first", async () => {
  // The producer already holds the head on block 1; `onblock` credits that round with block 2,
  // so the first producers read sees none and a later one sees the credit.
  const { ctx, seniorityReads } = chainContext(
    () => account,
    block => producerRow({ service_sec: block > 1 ? earnedSeniority : 0 })
  )
  await runPolled(plannedPhase("EntersSchedule"), ctx)
  Assert.deepEqual(seniorityReads, [0, earnedSeniority])
})

test("entering the schedule fails when the produced round's seniority never lands", async () => {
  const { ctx } = chainContext(
    () => account,
    () => producerRow()
  )
  await Assert.rejects(
    runPolled(plannedPhase("EntersSchedule"), ctx),
    /Timed out waiting for: the flow producer's row holds the produced round's seniority/
  )
})

test("the misses that demote the producer must take all of its seniority", async () => {
  const step = plannedStep("misses-accrue-then-demote")
  await run(step, context(demotedRow()))
  await Assert.rejects(
    run(step, context(demotedRow({ service_sec: "72" }))),
    /72s of seniority where it should hold none/
  )
})

test("the pardon must keep the registration order the producer took when it registered", async () => {
  const step = plannedStep("demotion-cleared")
  await run(
    step,
    context(producerRow({ registration_seq: String(registrationOrder) }), recordedOutputs())
  )
  await Assert.rejects(
    run(step, context(producerRow({ registration_seq: 4 }), recordedOutputs())),
    /moved the registration order from 3 to 4/
  )
  await Assert.rejects(
    run(step, context(producerRow({ registration_seq: 0 }), recordedOutputs())),
    /no registration order/
  )
})

/** The recovered producer's round holds blocks 1-6; block 7 is the next producer's. */
const recoveredRoundEnd = 6

/** Producers in the served-round tests: the flow producer's round, then the next producer's. */
const servedRoundProducer = block => (block <= recoveredRoundEnd ? account : otherProducer)

test("a round served after the pardon is judged a block after it ends and earns seniority back", async () => {
  // A round missed before it still counts until block 8 judges the served round's end at block 7.
  const { ctx } = chainContext(servedRoundProducer, block =>
    producerRow({
      service_sec: earnedSeniority,
      consecutive_missed_rounds: block > recoveredRoundEnd + 1 ? 0 : 1
    })
  )
  await runPolled([plannedStep("served-rounds-keep-the-record-clean")], ctx)
})

test("a round served after the pardon must earn seniority back", async () => {
  const { ctx } = chainContext(servedRoundProducer, () => producerRow())
  await Assert.rejects(
    runPolled([plannedStep("served-rounds-keep-the-record-clean")], ctx),
    /no seniority after serving a round/
  )
})
