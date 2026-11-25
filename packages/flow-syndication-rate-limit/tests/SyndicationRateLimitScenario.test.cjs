const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { SlugName } = require("@wireio/sdk-core")
const { Steps, SyndicationScenario } = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
const { waitDecidedAndIdle } = require("../lib/SyndicationRateLimitScenario.js")

afterEach(() => mock.restoreAll())

/** A zero `time_point`: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/** A context whose syndication chain runs 60 s minimum epochs. */
const context = { config: { outpostEpochDurationSec: { [SyndicationScenario.Chain]: 60 } } }

/** The syndication chain's `epochstate` at `index`, idle unless `dueAt` is set. */
function epochStates(index, dueAt = NoTraffic) {
  return {
    [SyndicationScenario.Chain]: {
      chain_code: SlugName.from(SyndicationScenario.Chain),
      current_epoch_index: index,
      due_at: dueAt,
      is_paused: false
    }
  }
}

/** The syndication chain's `outpcons` row, decided through `epochIndex`. */
function consensus(epochIndex) {
  return { [SyndicationScenario.Chain]: { epoch_index: epochIndex } }
}

/** Serve one (epochstate, outpcons) pair per read, the last repeating. */
function serveReads(...reads) {
  const next = () => (reads.length > 1 ? reads.shift() : reads[0])
  let current = null
  const states = mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => {
    current = next()
    return current.states
  })
  mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => current.consensus)
  return states
}

test("waits through a fresh, undecided epoch and a chain with traffic until it is decided and idle, adding no traffic", async () => {
  const reads = serveReads(
    // Just advanced: the outpost has not answered the new envelope yet.
    { states: epochStates(8), consensus: consensus(7) },
    // Decided, but traffic is pending: another advance is coming.
    { states: epochStates(8, "2026-11-25T00:01:00.000"), consensus: consensus(8) },
    { states: epochStates(9), consensus: consensus(9) }
  )
  const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  mock.method(StepTools, "pollUntil", async (_label, predicate) => {
    while (!(await predicate()));
  })
  await waitDecidedAndIdle(context, new AbortController().signal)
  Assert.equal(reads.mock.callCount(), 3)
  Assert.equal(push.mock.callCount(), 0)
})

test("times out naming the wait when the chain never settles decided and idle", async () => {
  serveReads({ states: epochStates(8), consensus: consensus(7) })
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  await Assert.rejects(
    waitDecidedAndIdle(context, new AbortController().signal),
    new RegExp(`Timed out waiting for: the ${SyndicationScenario.Chain} epoch is decided and the chain idle`)
  )
})

test("an aborted wait reads nothing", async () => {
  const reads = serveReads({ states: epochStates(9), consensus: consensus(9) })
  await Assert.rejects(waitDecidedAndIdle(context, AbortSignal.abort()))
  Assert.equal(reads.mock.callCount(), 0)
})
