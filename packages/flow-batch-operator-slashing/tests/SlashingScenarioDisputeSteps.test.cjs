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

/** The contested chain's `due_at` the chain-clock tests measure from (UTC ms). */
const DueMs = Date.parse("2026-11-24T00:00:00.000Z")

/** The chain-clock instant `offsetMs` from {@link DueMs}, as the chain renders it: UTC, no zone suffix. */
function chainTime(offsetMs) {
  return new Date(DueMs + offsetMs).toISOString().slice(0, -1)
}

/** A zero `time_point` as the chain renders it: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/**
 * The contested chain's `epochstate` row at `epochIndex`, its window seating `group`, due at
 * `dueAt` (traffic since a minimum before), or idle when `dueAt` is {@link NoTraffic}.
 */
function epochState(epochIndex, group, dueAt = chainTime(0)) {
  return {
    chain_code: String(SlugName.from(Constants.ContestedChain)),
    current_epoch_index: epochIndex,
    traffic_since: dueAt === NoTraffic ? NoTraffic : chainTime(-Constants.EpochDurationSec * 1_000),
    due_at: dueAt,
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

describe("hasAdvanceHeadroom / isDue", () => {
  test("an idle chain always has the headroom and is never due: idle means no straddle", () => {
    const idle = epochState(ContestedEpoch, DisputeAccounts, NoTraffic)
    Assert.equal(DisputeSteps.hasAdvanceHeadroom(idle, chainTime(0), Constants.activationHeadroomMs()), true)
    Assert.equal(DisputeSteps.isDue(idle, chainTime(10_000)), false)
  })

  test("a chain with traffic has the headroom only while its due_at is far enough ahead", () => {
    const busy = epochState(ContestedEpoch, DisputeAccounts),
      headroomMs = Constants.activationHeadroomMs()
    Assert.equal(DisputeSteps.hasAdvanceHeadroom(busy, chainTime(-headroomMs), headroomMs), true)
    Assert.equal(DisputeSteps.hasAdvanceHeadroom(busy, chainTime(-headroomMs + 1), headroomMs), false)
  })

  test("a chain with traffic is due from its due_at on", () => {
    const busy = epochState(ContestedEpoch, DisputeAccounts)
    Assert.equal(DisputeSteps.isDue(busy, chainTime(-1)), false)
    Assert.equal(DisputeSteps.isDue(busy, chainTime(0)), true)
    Assert.equal(DisputeSteps.isDue(busy, `${chainTime(2_500)}Z`), true)
  })

  test("an unparsable head passes neither check", () => {
    const busy = epochState(ContestedEpoch, DisputeAccounts)
    Assert.equal(DisputeSteps.hasAdvanceHeadroom(busy, "not a time", 0), false)
    Assert.equal(DisputeSteps.isDue(busy, "not a time"), false)
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
  test("returns at once when the chain is idle", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts, NoTraffic))
    await DisputeSteps.runAwaitActivationHeadroom(clockContext(chainTime(0)), null, new AbortController().signal)
    Assert.equal(read.mock.callCount(), 1)
  })

  test("returns at once when the chain clock has the headroom before its due_at", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts))
    await DisputeSteps.runAwaitActivationHeadroom(
      clockContext(chainTime(-Constants.activationHeadroomMs())),
      null,
      new AbortController().signal
    )
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("keeps polling while the due_at is too close, until the advance leaves the chain idle", async () => {
    const head = chainTime(-1_000),
      read = serveEpochStates(
        epochState(ContestedEpoch, DisputeAccounts, chainTime(0)),
        epochState(ContestedEpoch + 1, DisputeAccounts, NoTraffic)
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
  test("returns once the contested chain's active group is the dispute operators, adding no traffic then", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => DisputeAccounts),
      push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
    await DisputeSteps.runAwaitSoleActiveGroup({ keyStore }, null, new AbortController().signal)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
    Assert.equal(push.mock.callCount(), 0)
  })

  test("gives the idle contested chain traffic until the advance seats the dispute operators", async () => {
    const groups = [["batchop.a", "batchop.b", "batchop.c"], DisputeAccounts]
    mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => groups.shift() ?? DisputeAccounts)
    mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({
      [Constants.ContestedChain]: { ...epochState(ContestedEpoch, ["batchop.a"], NoTraffic), is_paused: false },
      [Constants.RunningChain]: { ...epochState(4, ["batchop.b"], NoTraffic), is_paused: false }
    }))
    const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
    await DisputeSteps.runAwaitSoleActiveGroup({ keyStore }, null, new AbortController().signal)
    Assert.deepEqual(
      push.mock.calls.map(call => call.arguments[1].data.chain_code),
      [Constants.ContestedChain]
    )
  })

  test("an aborted step does not poll", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => DisputeAccounts),
      aborted = new AbortController()
    aborted.abort()
    await Assert.rejects(DisputeSteps.runAwaitSoleActiveGroup({ keyStore }, null, aborted.signal))
    Assert.equal(read.mock.callCount(), 0)
  })
})

/** A build context whose chain head is at `headBlockTime` and whose staged contested epoch is {@link ContestedEpoch}. */
function contestedContext(headBlockTime) {
  const ctx = clockContext(headBlockTime)
  ctx.outputs.set(DisputeSteps.ContestedEpochKey, ContestedEpoch)
  return ctx
}

describe("runAwaitContestedChainDue", () => {
  test("polls the contested chain until its due_at is reached", async () => {
    const read = serveEpochStates(
      epochState(ContestedEpoch, DisputeAccounts, chainTime(1_000)),
      epochState(ContestedEpoch, DisputeAccounts, chainTime(0))
    )
    await DisputeSteps.runAwaitContestedChainDue(contestedContext(chainTime(0)), null, new AbortController().signal)
    Assert.equal(read.mock.callCount(), 2)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
  })

  test("returns once a relay's liveness crank moved the chain past the contested epoch, though it is not due", async () => {
    const read = serveEpochStates(
      epochState(ContestedEpoch, DisputeAccounts, chainTime(1_000)),
      epochState(ContestedEpoch + 1, DisputeAccounts, NoTraffic)
    )
    await DisputeSteps.runAwaitContestedChainDue(contestedContext(chainTime(0)), null, new AbortController().signal)
    Assert.equal(read.mock.callCount(), 2)
  })

  test("pushes no traffic while the chain is idle: the resolution's own traffic makes it due", async () => {
    const read = serveEpochStates(
        epochState(ContestedEpoch, DisputeAccounts, NoTraffic),
        epochState(ContestedEpoch, DisputeAccounts, chainTime(0))
      ),
      states = mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({
        [Constants.ContestedChain]: { ...epochState(ContestedEpoch, DisputeAccounts, NoTraffic), is_paused: false },
        [Constants.RunningChain]: { ...epochState(4, ["batchop.b"], NoTraffic), is_paused: false }
      })),
      push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
    await DisputeSteps.runAwaitContestedChainDue(contestedContext(chainTime(0)), null, new AbortController().signal)
    Assert.equal(read.mock.callCount(), 2)
    Assert.equal(push.mock.callCount(), 0)
    Assert.equal(states.mock.callCount(), 0)
  })

  test("reads nothing without a staged contested epoch", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts))
    await Assert.rejects(
      DisputeSteps.runAwaitContestedChainDue(clockContext(chainTime(0)), null, new AbortController().signal)
    )
    Assert.equal(read.mock.callCount(), 0)
  })

  test("the factory wires the runner, and an aborted step does not poll", async () => {
    const step = DisputeSteps.planAwaitContestedChainDue("Sysio", "due", "probe", {}),
      read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts))
    Assert.equal(step.runner, DisputeSteps.runAwaitContestedChainDue)
    Assert.equal(step.input, null)
    await Assert.rejects(DisputeSteps.runAwaitContestedChainDue(contestedContext(chainTime(0)), null, AbortSignal.abort()))
    Assert.equal(read.mock.callCount(), 0)
  })
})

describe("runCrankContestedChain", () => {
  /** The crank step, carrying the contested chain's `chkcons` data. */
  function crankStep() {
    return DisputeSteps.planCrankContestedChain(Report.Actor.Sysio, "crank", "crank", {})
  }

  test("the factory carries the contested chain's chkcons data and its named runner", () => {
    const step = crankStep()
    Assert.deepEqual(step.input, {
      kind: "MsgchContractSteps.ChkconsInput",
      data: { chain_code: Constants.ContestedChainCode }
    })
    Assert.equal(step.runner, DisputeSteps.runCrankContestedChain)
  })

  test("pushes the chkcons while the chain is still at the contested epoch", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts)),
      crank = mock.method(Steps.contracts.sysio.msgch, "runChkcons", async () => undefined),
      step = crankStep()
    await DisputeSteps.runCrankContestedChain(contestedContext(chainTime(0)), step.input, new AbortController().signal)
    Assert.equal(read.mock.calls[0].arguments[1], Constants.ContestedChain)
    Assert.equal(crank.mock.callCount(), 1)
    Assert.equal(crank.mock.calls[0].arguments[1], step.input)
  })

  test("pushes nothing once a relay's liveness crank moved the chain past the contested epoch", async () => {
    serveEpochStates(epochState(ContestedEpoch + 1, DisputeAccounts, NoTraffic))
    const crank = mock.method(Steps.contracts.sysio.msgch, "runChkcons", async () => undefined)
    await DisputeSteps.runCrankContestedChain(contestedContext(chainTime(0)), crankStep().input, new AbortController().signal)
    Assert.equal(crank.mock.callCount(), 0)
  })

  test("an aborted step reads and pushes nothing", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts)),
      crank = mock.method(Steps.contracts.sysio.msgch, "runChkcons", async () => undefined)
    await Assert.rejects(
      DisputeSteps.runCrankContestedChain(contestedContext(chainTime(0)), crankStep().input, AbortSignal.abort())
    )
    Assert.equal(read.mock.callCount(), 0)
    Assert.equal(crank.mock.callCount(), 0)
  })
})

/** A build context with no chain clock: a read of the chain head fails the test. */
function clocklessContext() {
  return {
    keyStore,
    outputs: new OutputStore(),
    wire: {
      getInfo: async () => {
        throw new Error("the chain head was read")
      }
    }
  }
}

describe("runStageContestedEpoch", () => {
  test("captures the epoch the dispute operators own without waiting for its boundary", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, [...DisputeAccounts].reverse(), chainTime(60_000))),
      ctx = clocklessContext()
    await DisputeSteps.runStageContestedEpoch(ctx, null, new AbortController().signal)
    Assert.equal(ctx.outputs.assert(DisputeSteps.ContestedEpochKey), ContestedEpoch)
    Assert.equal(read.mock.callCount(), 1)
  })

  test("refuses an epoch whose active group still seats a bootstrapped operator, capturing nothing", async () => {
    serveEpochStates(epochState(ContestedEpoch, [DisputeAccounts[0], "batchop.a", "batchop.b"]))
    const ctx = clocklessContext()
    await Assert.rejects(
      DisputeSteps.runStageContestedEpoch(ctx, null, new AbortController().signal),
      /is not owned by the dispute operators alone/
    )
    Assert.equal(ctx.outputs.has(DisputeSteps.ContestedEpochKey), false)
  })

  test("an aborted step reads nothing", async () => {
    const read = serveEpochStates(epochState(ContestedEpoch, DisputeAccounts)),
      aborted = new AbortController()
    aborted.abort()
    await Assert.rejects(DisputeSteps.runStageContestedEpoch(clocklessContext(), null, aborted.signal))
    Assert.equal(read.mock.callCount(), 0)
  })
})

describe("runAwaitOperatorSlashed", () => {
  /**
   * A build context whose `sysio.opreg::operators` reads serve `statuses` in turn (repeating the last) for the
   * losing operator, and which offers no action, so a crank fails the test.
   */
  function operatorsContext(...statuses) {
    const reads = []
    return {
      reads,
      keyStore,
      wire: {
        getSysioContract: contract => ({
          tables: {
            operators: {
              query: async () => {
                reads.push(contract)
                return { rows: [{ account: Constants.LosingOperators[0], status: statuses[Math.min(reads.length - 1, statuses.length - 1)] }] }
              }
            }
          }
        })
      }
    }
  }

  /** The step input for the first losing operator. */
  const input = {
    kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput",
    label: Constants.LosingOperators[0]
  }

  test("returns once the operator reads SLASHED, cranking nothing", async () => {
    const ctx = operatorsContext("OPERATOR_STATUS_SLASHED")
    await DisputeSteps.runAwaitOperatorSlashed(ctx, input, new AbortController().signal)
    Assert.deepEqual(ctx.reads, [SysioContracts.SysioContractName.opreg])
  })

  test("keeps reading while the operator is still ACTIVE", async () => {
    const ctx = operatorsContext("OPERATOR_STATUS_ACTIVE", "OPERATOR_STATUS_SLASHED")
    await DisputeSteps.runAwaitOperatorSlashed(ctx, input, new AbortController().signal)
    Assert.equal(ctx.reads.length, 2)
  })

  test("an aborted step reads nothing", async () => {
    const ctx = operatorsContext("OPERATOR_STATUS_SLASHED"),
      aborted = new AbortController()
    aborted.abort()
    await Assert.rejects(DisputeSteps.runAwaitOperatorSlashed(ctx, input, aborted.signal))
    Assert.equal(ctx.reads.length, 0)
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

  test("planStageContestedEpoch carries no input and its named runner", () => {
    const step = DisputeSteps.planStageContestedEpoch(Report.Actor.Sysio, "stage", "stage", { timeoutMs: 1 })
    Assert.equal(step.input, null)
    Assert.equal(step.runner, DisputeSteps.runStageContestedEpoch)
    Assert.equal(step.options.timeoutMs, 1)
  })

  test("planAwaitOperatorSlashed carries the operator's label and its named runner", () => {
    const step = DisputeSteps.planAwaitOperatorSlashed(
      Report.Actor.Sysio,
      "slashed",
      "slashed",
      { timeoutMs: 1 },
      Constants.LosingOperators[0]
    )
    Assert.deepEqual(step.input, {
      kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput",
      label: Constants.LosingOperators[0]
    })
    Assert.equal(step.runner, DisputeSteps.runAwaitOperatorSlashed)
  })
})

describe("slashedAccounts / readSlashedOperators / assertNoNewSlash", () => {
  /** An `operators` row of `account` at `status`, by enum name or value. */
  function operatorRow(account, status) {
    return { account, status }
  }

  test("keeps only the SLASHED operators, by name or value, in account order", () => {
    const { SysioOpregOperatorstatus: Status } = SysioContracts
    Assert.deepEqual(
      DisputeSteps.slashedAccounts([
        operatorRow("dispop.c", "OPERATOR_STATUS_SLASHED"),
        operatorRow("batchop.a", "OPERATOR_STATUS_ACTIVE"),
        operatorRow("dispop.a", Status.OPERATOR_STATUS_SLASHED),
        operatorRow("dispop.b", "OPERATOR_STATUS_TERMINATED")
      ]),
      ["dispop.a", "dispop.c"]
    )
    Assert.deepEqual(DisputeSteps.slashedAccounts([]), [])
  })

  test("reads every operators row through a paged read", async () => {
    const queryAll = mock.fn(async () => [operatorRow("dispop.b", "OPERATOR_STATUS_SLASHED")]),
      ctx = { wire: { getSysioContract: () => ({ tables: { operators: { queryAll } } }) } }
    Assert.deepEqual(await DisputeSteps.readSlashedOperators(ctx), ["dispop.b"])
    Assert.deepEqual(queryAll.mock.calls[0].arguments[0], { limit: Constants.OperatorTableReadLimit })
  })

  test("passes an unchanged or shrunk SLASHED set and names every newly slashed account", () => {
    DisputeSteps.assertNoNewSlash(["dispop.a"], ["dispop.a"], "the advance")
    DisputeSteps.assertNoNewSlash(["dispop.a", "dispop.b"], ["dispop.a"], "the advance")
    Assert.throws(
      () => DisputeSteps.assertNoNewSlash(["dispop.a"], ["batchop.a", "dispop.a", "dispop.c"], "the advance"),
      /the advance slashed batchop\.a, dispop\.c/
    )
  })
})

describe("runRecordSlashedOperators", () => {
  test("stores the SLASHED operators under SlashedOperatorsKey", async () => {
    const rows = [
        { account: "dispop.c", status: "OPERATOR_STATUS_SLASHED" },
        { account: "batchop.a", status: "OPERATOR_STATUS_ACTIVE" },
        { account: "dispop.a", status: "OPERATOR_STATUS_SLASHED" }
      ],
      step = DisputeSteps.planRecordSlashedOperators("Sysio", "record", "probe", {}),
      ctx = {
        outputs: new OutputStore(),
        wire: { getSysioContract: () => ({ tables: { operators: { queryAll: async () => rows } } }) }
      }
    Assert.equal(step.runner, DisputeSteps.runRecordSlashedOperators)
    Assert.equal(step.input, null)
    await DisputeSteps.runRecordSlashedOperators(ctx, null, new AbortController().signal)
    Assert.deepEqual(ctx.outputs.assert(DisputeSteps.SlashedOperatorsKey), ["dispop.a", "dispop.c"])
  })

  test("an aborted step reads nothing", async () => {
    const queryAll = mock.fn(async () => []),
      ctx = {
        outputs: new OutputStore(),
        wire: { getSysioContract: () => ({ tables: { operators: { queryAll } } }) }
      }
    await Assert.rejects(DisputeSteps.runRecordSlashedOperators(ctx, null, AbortSignal.abort()))
    Assert.equal(queryAll.mock.callCount(), 0)
  })
})
