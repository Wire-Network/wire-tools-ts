const Assert = require("node:assert/strict")
const { test, describe, afterEach, mock } = require("node:test")

const { SlugName, SysioContracts } = require("@wireio/sdk-core")
const { Constants: HarnessConstants, OutputStore, Report, Steps } = require("@wireio/cluster-tool")

const { SlashingScenarioDisputeSteps: DisputeSteps } = require("../lib/steps/SlashingScenarioDisputeSteps.js")
const { SlashingScenarioConstants: Constants } = require("../lib/SlashingScenarioConstants.js")

const { SysioChalgDisputestatus: DisputeStatus } = SysioContracts,
  ContestedEpoch = 7

afterEach(() => mock.restoreAll())

/** A `sysio.chalg::disputes` row of `chain` at `epochIndex`, as the RPC renders it (a packed code). */
function dispute(id, chain, epochIndex, status = "DISPUTE_STATUS_OPEN") {
  return { id, chain_code: String(SlugName.from(chain)), epoch_index: epochIndex, status }
}

/** A build context whose `disputes` read returns `rows`. */
function disputesContext(rows) {
  return {
    wire: {
      getSysioContract: () => ({ tables: { disputes: { query: async () => ({ rows, more: false }) } } })
    }
  }
}

describe("findOpenDispute", () => {
  test("matches the contested chain's open dispute at the epoch", async () => {
    const found = await DisputeSteps.findOpenDispute(
      disputesContext([
        dispute(1, Constants.RunningChain, ContestedEpoch),
        dispute(2, Constants.ContestedChain, ContestedEpoch),
        dispute(3, Constants.ContestedChain, ContestedEpoch + 1)
      ]),
      ContestedEpoch
    )
    Assert.equal(found.id, 2)
  })

  test("an open dispute by status value matches too", async () => {
    const found = await DisputeSteps.findOpenDispute(
      disputesContext([dispute(4, Constants.ContestedChain, ContestedEpoch, DisputeStatus.DISPUTE_STATUS_OPEN)]),
      ContestedEpoch
    )
    Assert.equal(found.id, 4)
  })

  test("the other chain's open dispute at the same epoch index does not match", async () => {
    Assert.equal(
      await DisputeSteps.findOpenDispute(
        disputesContext([dispute(1, Constants.RunningChain, ContestedEpoch)]),
        ContestedEpoch
      ),
      undefined
    )
  })

  test("a dispute of the contested chain that is no longer open does not match", async () => {
    const closed = Object.keys(DisputeStatus).find(
      name => Number.isNaN(Number(name)) && name !== "DISPUTE_STATUS_OPEN"
    )
    Assert.equal(
      await DisputeSteps.findOpenDispute(
        disputesContext([dispute(5, Constants.ContestedChain, ContestedEpoch, closed)]),
        ContestedEpoch
      ),
      undefined
    )
  })

  test("a chain code that is not a packed code is refused, not misread", async () => {
    await Assert.rejects(
      DisputeSteps.findOpenDispute(
        disputesContext([{ ...dispute(6, Constants.ContestedChain, ContestedEpoch), chain_code: "ETHEREUM" }]),
        ContestedEpoch
      ),
      /must hold an unsigned decimal, got "ETHEREUM"/
    )
  })
})

describe("epochPaused", () => {
  /** Serve each chain's `epochstate` with its pause flag from `paused`. */
  function pauses(paused) {
    return mock.method(Steps.contracts.sysio.epoch, "readEpochState", async (_ctx, chain) => ({
      chain_code: String(SlugName.from(chain)),
      is_paused: paused[chain]
    }))
  }

  test("reads the contested chain unless another is named", async () => {
    const read = pauses({ [Constants.ContestedChain]: true, [Constants.RunningChain]: false })
    Assert.equal(await DisputeSteps.epochPaused({}), true)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("reads the named chain's own pause, not the contested chain's", async () => {
    const read = pauses({ [Constants.ContestedChain]: true, [Constants.RunningChain]: false })
    Assert.equal(await DisputeSteps.epochPaused({}, Constants.RunningChain), false)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.RunningChain)
    Assert.notEqual(Constants.RunningChain, Constants.ContestedChain)
    Assert.ok(
      [HarnessConstants.ETHEREUM_CHAIN_CODENAME, HarnessConstants.SOLANA_CHAIN_CODENAME].includes(Constants.RunningChain)
    )
  })

  test("a chain whose row renders the flag as a number reads as a boolean", async () => {
    pauses({ [Constants.ContestedChain]: 1, [Constants.RunningChain]: 0 })
    Assert.equal(await DisputeSteps.epochPaused({}), true)
    Assert.equal(await DisputeSteps.epochPaused({}, Constants.RunningChain), false)
  })
})

/** The dispute operators' accounts: {@link keyStore} resolves each label to the account of its name. */
const DisputeAccounts = [...Constants.DisputeOperators]

/** A key store resolving every operator label to the account of the same name. */
const keyStore = { assertOperator: label => ({ account: label }) }

/** The contested chain's boundary the chain-clock tests measure from (UTC ms). */
const BoundaryMs = Date.parse("2026-11-24T00:00:00.000Z")

/** The chain-clock instant `offsetMs` from {@link BoundaryMs}, as the chain renders it: UTC, no zone suffix. */
function chainTime(offsetMs) {
  return new Date(BoundaryMs + offsetMs).toISOString().slice(0, -1)
}

/** The contested chain's `epochstate` row at `epochIndex`, its window seating `group`, its boundary at `nextEpochStart`. */
function epochState(epochIndex, group, nextEpochStart = chainTime(0)) {
  return {
    chain_code: String(SlugName.from(Constants.ContestedChain)),
    current_epoch_index: epochIndex,
    next_epoch_start: nextEpochStart,
    batch_op_groups: [group],
    current_batch_op_group: 0
  }
}

/** Serve `states` from successive `epochstate` reads, repeating the last. */
function serveEpochStates(...states) {
  let reads = 0
  return mock.method(Steps.contracts.sysio.epoch, "readEpochState", async () =>
    states[Math.min(reads++, states.length - 1)]
  )
}

/** A build context whose chain head is at `headBlockTime`. */
function clockContext(headBlockTime) {
  return {
    keyStore,
    outputs: new OutputStore(),
    wire: { getInfo: async () => ({ head_block_time: headBlockTime }) }
  }
}

/** A `sysio.msgch::envelopes` row of `chain` at `epochIndex` delivered by `operator`, as the RPC renders it. */
function envelope(chain, epochIndex, operator) {
  return { chain_code: String(SlugName.from(chain)), epoch_index: epochIndex, batch_op_name: operator }
}

describe("isExactGroup", () => {
  test("the dispute operators in any order are exactly the group", () => {
    Assert.equal(DisputeSteps.isExactGroup([...DisputeAccounts].reverse(), DisputeAccounts), true)
  })

  test("a group missing a dispute operator, or also seating a bootstrapped one, is not", () => {
    Assert.equal(DisputeSteps.isExactGroup(DisputeAccounts.slice(1), DisputeAccounts), false)
    Assert.equal(DisputeSteps.isExactGroup([...DisputeAccounts.slice(1), "batchop.a"], DisputeAccounts), false)
    Assert.equal(DisputeSteps.isExactGroup([...DisputeAccounts, "batchop.a"], DisputeAccounts), false)
  })

  test("an absent group is not", () => {
    Assert.equal(DisputeSteps.isExactGroup(undefined, DisputeAccounts), false)
  })
})

describe("disputeOperatorsOwnGroup", () => {
  test("matches the contested chain's active group against the dispute operators", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () =>
      [...DisputeAccounts].reverse()
    )
    Assert.equal(await DisputeSteps.disputeOperatorsOwnGroup({ keyStore }), true)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("a group still seating a bootstrapped operator does not match", async () => {
    mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => [
      DisputeAccounts[0],
      "batchop.a",
      "batchop.b"
    ])
    Assert.equal(await DisputeSteps.disputeOperatorsOwnGroup({ keyStore }), false)
  })
})

describe("msUntilEpochBoundary", () => {
  test("is positive before the boundary and negative past it", () => {
    Assert.equal(DisputeSteps.msUntilEpochBoundary(chainTime(0), chainTime(-1_500)), 1_500)
    Assert.equal(DisputeSteps.msUntilEpochBoundary(chainTime(0), chainTime(2_500)), -2_500)
  })

  test("a timestamp carrying the zone suffix reads as the same instant", () => {
    Assert.equal(DisputeSteps.msUntilEpochBoundary(`${chainTime(0)}Z`, chainTime(-1_000)), 1_000)
  })

  test("an unparsable timestamp yields NaN, which passes no comparison", () => {
    const left = DisputeSteps.msUntilEpochBoundary("not a time", chainTime(0))
    Assert.ok(Number.isNaN(left))
    Assert.equal(left >= 0 || left <= 0, false)
  })
})

describe("outpostEpochEnvelopes", () => {
  test("keeps only the chain's deliveries for the epoch", () => {
    const bucket = DisputeSteps.outpostEpochEnvelopes(
      [
        envelope(Constants.ContestedChain, ContestedEpoch, "dispop.a"),
        envelope(Constants.ContestedChain, ContestedEpoch - 1, "batchop.a"),
        envelope(Constants.RunningChain, ContestedEpoch, "batchop.b"),
        envelope(Constants.ContestedChain, ContestedEpoch, "dispop.b")
      ],
      Constants.ContestedChain,
      ContestedEpoch
    )
    Assert.deepEqual(
      bucket.map(row => row.batch_op_name),
      ["dispop.a", "dispop.b"]
    )
  })

  test("an empty table yields an empty bucket", () => {
    Assert.deepEqual(DisputeSteps.outpostEpochEnvelopes([], Constants.ContestedChain, ContestedEpoch), [])
  })
})

describe("readEnvelopes", () => {
  /** A build context whose `sysio.msgch::envelopes` read returns `rows` and `more`, recording each read. */
  function envelopesContext(rows, more) {
    const reads = []
    return {
      reads,
      wire: {
        getSysioContract: contract => ({
          tables: {
            envelopes: {
              query: async options => {
                reads.push({ contract, options })
                return { rows, more }
              }
            }
          }
        })
      }
    }
  }

  test("reads sysio.msgch::envelopes within the row ceiling", async () => {
    const rows = [envelope(Constants.ContestedChain, ContestedEpoch, "dispop.a")],
      ctx = envelopesContext(rows, false)
    Assert.deepEqual(await DisputeSteps.readEnvelopes(ctx), rows)
    Assert.deepEqual(ctx.reads, [
      { contract: SysioContracts.SysioContractName.msgch, options: { limit: Constants.EnvelopeTableReadLimit } }
    ])
  })

  test("a truncated read is refused rather than trusted", async () => {
    await Assert.rejects(DisputeSteps.readEnvelopes(envelopesContext([], true)), /the read is truncated/)
  })
})

describe("runAwaitActivationHeadroom", () => {
  test("returns at once when the chain clock has the headroom before the boundary", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts))
    await DisputeSteps.runAwaitActivationHeadroom(
      clockContext(chainTime(-Constants.activationHeadroomMs())),
      null,
      new AbortController().signal
    )
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("keeps polling while the boundary is too close, until the next epoch opens", async () => {
    const head = chainTime(-1_000),
      read = serveEpochStates(
        epochState(ContestedEpoch, DisputeAccounts, chainTime(0)),
        epochState(ContestedEpoch + 1, DisputeAccounts, chainTime(Constants.EpochDurationSec * 1_000))
      )
    await DisputeSteps.runAwaitActivationHeadroom(clockContext(head), null, new AbortController().signal)
    Assert.equal(read.mock.callCount(), 2)
  })

  test("an aborted step does not poll", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts)),
      aborted = new AbortController()
    aborted.abort()
    await Assert.rejects(DisputeSteps.runAwaitActivationHeadroom(clockContext(chainTime(0)), null, aborted.signal))
    Assert.equal(read.mock.callCount(), 0)
  })
})

describe("runAwaitSoleActiveGroup", () => {
  test("returns once the contested chain's active group is the dispute operators", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => DisputeAccounts)
    await DisputeSteps.runAwaitSoleActiveGroup({ keyStore }, null, new AbortController().signal)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("an aborted step does not poll", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => DisputeAccounts),
      aborted = new AbortController()
    aborted.abort()
    await Assert.rejects(DisputeSteps.runAwaitSoleActiveGroup({ keyStore }, null, aborted.signal))
    Assert.equal(read.mock.callCount(), 0)
  })
})

describe("runStageContestedEpoch", () => {
  test("captures the epoch past its boundary that the dispute operators own", async () => {
    serveEpochStates(epochState(ContestedEpoch, [...DisputeAccounts].reverse()))
    const ctx = clockContext(chainTime(Constants.EpochBoundaryMarginMs))
    await DisputeSteps.runStageContestedEpoch(ctx, null, new AbortController().signal)
    Assert.equal(ctx.outputs.assert(DisputeSteps.ContestedEpochKey), ContestedEpoch)
  })

  test("refuses an epoch whose active group still seats a bootstrapped operator, capturing nothing", async () => {
    serveEpochStates(epochState(ContestedEpoch, [DisputeAccounts[0], "batchop.a", "batchop.b"]))
    const ctx = clockContext(chainTime(Constants.EpochBoundaryMarginMs))
    await Assert.rejects(
      DisputeSteps.runStageContestedEpoch(ctx, null, new AbortController().signal),
      /is not owned by the dispute operators alone/
    )
    Assert.equal(ctx.outputs.has(DisputeSteps.ContestedEpochKey), false)
  })
})

describe("await step factories", () => {
  test("planAwaitActivationHeadroom carries no input and its named runner", () => {
    const step = DisputeSteps.planAwaitActivationHeadroom(Report.Actor.Sysio, "headroom", "headroom", { timeoutMs: 1 })
    Assert.equal(step.input, null)
    Assert.equal(step.runner, DisputeSteps.runAwaitActivationHeadroom)
    Assert.equal(step.options.timeoutMs, 1)
  })

  test("planAwaitSoleActiveGroup carries no input and its named runner", () => {
    const step = DisputeSteps.planAwaitSoleActiveGroup(Report.Actor.Sysio, "sole", "sole", { timeoutMs: 1 })
    Assert.equal(step.input, null)
    Assert.equal(step.runner, DisputeSteps.runAwaitSoleActiveGroup)
    Assert.equal(step.options.timeoutMs, 1)
  })
})
