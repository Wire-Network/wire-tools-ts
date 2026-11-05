const Assert = require("node:assert/strict")
const { test } = require("node:test")
const {
  ClusterBuild,
  OutputStore,
  ProducerTier,
  ProducerTierShift
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
const signal = new AbortController().signal

/** Every step of a planned tree, in registration order. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** The first step the scenario plans under `name`. */
function plannedStep(name) {
  const build = ClusterBuild.forContext({
    outputs: new OutputStore(),
    config: { epochDurationSec: Constants.EpochDurationSec }
  })
  new ProducerRegistrationScenario().plan(build)
  return steps(build).find(step => step.name === name)
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

/** A context whose reads answer with `row`, with `headProducer` holding the head block. */
function context(row, headProducer = account, outputs = new OutputStore()) {
  return {
    outputs,
    keyStore: {
      assertOperator: label => {
        Assert.equal(label, Constants.ProducerLabel)
        return { account }
      }
    },
    wire: {
      getProducers: async () => ({ rows: [row] }),
      getInfo: async () => ({ head_block_producer: headProducer })
    }
  }
}

const run = (step, ctx) => step.runner(ctx, step.input, signal)

test("the flow installs the shipped seniority defaults around its own demotion threshold", () => {
  Assert.deepEqual(plannedStep("setscorecfg").input.data, {
    weights: Constants.ScoreConfig
  })
  Assert.deepEqual(Constants.ScoreConfig, {
    collateral_weight: 0,
    snapshot_weight: 259_200,
    relay_weight: 0,
    api_weight: 0,
    benchmark_weight: 0,
    max_consecutive_missed_rounds: 3,
    snapshot_target_attestations: 1,
    min_blocks_per_round: 0,
    miss_penalty_sec: 604_800
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

test("a producer that has produced a block must hold seniority", async () => {
  const step = plannedStep("producer-produces-a-block")
  await run(step, context(producerRow({ service_sec: 72 })))
  await Assert.rejects(
    run(step, context(producerRow())),
    /no seniority after serving a round/
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
    context(producerRow({ registration_seq: String(registrationOrder) }), account, recordedOutputs())
  )
  await Assert.rejects(
    run(step, context(producerRow({ registration_seq: 4 }), account, recordedOutputs())),
    /moved the registration order from 3 to 4/
  )
  await Assert.rejects(
    run(step, context(producerRow({ registration_seq: 0 }), account, recordedOutputs())),
    /no registration order/
  )
})

test("a round served after the pardon must earn seniority back", async () => {
  // The round has ended: another producer holds the head, so its verdict is in.
  const step = plannedStep("served-rounds-keep-the-record-clean")
  await run(step, context(producerRow({ service_sec: 72 }), otherProducer))
  await Assert.rejects(
    run(step, context(producerRow(), otherProducer)),
    /no seniority after serving a round/
  )
})
