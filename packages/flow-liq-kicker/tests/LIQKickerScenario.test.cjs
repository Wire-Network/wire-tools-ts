const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { cloneDeep } = require("lodash")
const { ClusterBuild, OutputStore, StepExtraRecorder } = require("@wireio/cluster-tool")
const { LIQKickerScenario, kickReceipt, readWireHoldings, expectedGiftAtBlock } = require("../lib/LIQKickerScenario.js")

const LastKickBefore = "2026-10-10T12:00:00.000"
const LastKickAfter = "2026-10-10T12:10:00.500"
const Gift = 3805n
const Budget = 1_000_000_000_000_000n

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

function phaseNames(build) {
  return build.children.map(child => child.name)
}

/** A throwaway executable that prints `help` for `--help`, standing in for nodeop. */
function fakeNodeop(help) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "kicker-nodeop-")),
    file = Path.join(dir, "nodeop")
  Fs.writeFileSync(file, `#!/bin/sh\necho '${help}'\n`, { mode: 0o755 })
  return { file, cleanup: () => Fs.rmSync(dir, { recursive: true, force: true }) }
}

function planned(nodeop) {
  const ctx = { outputs: new OutputStore(), config: { executables: { nodeop } } },
    build = ClusterBuild.forContext(ctx)
  new LIQKickerScenario().plan(build)
  return { ctx, build }
}

/** One chain state the flow's reads see, in base units. */
function chainState({ lastKick, giftedTotal, budget, index, pot, carry, treasury, buckets, minGift }) {
  return {
    config: { budget_remaining: String(budget), min_interval_sec: 60, twap_window_sec: 60 },
    pool: {
      sym: "LIQETH", rate_bps: 200, min_gift: minGift ?? 1_000_000_000, last_kick: lastKick,
      gifted_total: String(giftedTotal), shortfall_amount: 0, shortfall_time: "1970-01-01T00:00:00.000",
      gift_overflow: false, price_time: lastKick, price_snapshot: { hi: "0", lo: String((BigInt(Date.parse(lastKick + "Z") - Date.parse(LastKickBefore + "Z")) * 1000n) << 64n) }, max_gift_per_day: 1_000_000_000_000, day: 0, spent_today: "0"
    },
    supply: "10.000000000 LIQETH",
    pair: { pool1: { quantity: "10.000000000 LIQETH" }, pool2: { quantity: "10.000000000 WIRE" } },
    yieldIndex: index == null ? null : { index: String(index), pot, carry },
    balances: { "sysio": treasury, "sysio.ops": buckets, "sysio.gov": 0n, "sysio.kicker": 0n }
  }
}

/** A `ctx.wire` whose typed tables and balances answer from `state` (mutable between steps). */
function fakeWire(holder) {
  const table = rows => ({ query: async () => ({ rows: cloneDeep(rows()), more: false }) })
  return {
    getSysioContract: name => ({
      tables: {
        kicker: { kickcfg: table(() => [holder.state.config]), kickpools: table(() => [holder.state.pool]) },
        liq: {
          stat: table(() => [{ supply: holder.state.supply }]),
          yieldidx: table(() => (holder.state.yieldIndex ? [holder.state.yieldIndex] : []))
        },
        system: { emitcfg: table(() => [holder.state.emissionConfig ?? { t5_distributable: "375000000000000000", t5_floor: "7500000000000000" }]), t5state: table(() => [{ total_distributed: "1000000" }]) },
        swap: { stat: table(() => [holder.state.pair]), priceaccum: table(() => [holder.state.accumulator ?? { last_update: LastKickBefore, price1: { hi: "0", lo: "0" }, price2: { hi: "0", lo: "0" } }]) }
      }[name]
    }),
    getWireBalance: async account => holder.state.balances[account] ?? 0n
  }
}

const before = chainState({
    lastKick: LastKickBefore, giftedTotal: 0n, budget: Budget, index: null,
    treasury: 700_000_000_000_000_000n, buckets: 5_000n
  }),
  // An epoch advance inside the window moved 1,000 units from the treasury to sysio.ops.
  after = chainState({
    lastKick: LastKickAfter, giftedTotal: Gift, budget: Budget - Gift, index: 380_500n, pot: 3805, carry: 0,
    treasury: 700_000_000_000_000_000n - Gift - 1_000n, buckets: 6_000n
  })

async function runManualVerifies(holder, receipt) {
  const { ctx, build } = planned(null)
  ctx.wire = fakeWire(holder)
  ctx.log = { info() {}, warn() {} }
  const byName = name => steps(build).find(step => step.name === name),
    run = step => step.runner(ctx, step.input, new AbortController().signal)
  holder.state = before
  await run(byName("snapshot-before-kick"))
  ctx.outputs.set(LIQKickerScenario.KickReceiptKey, receipt)
  holder.state = holder.after
  await run(byName("gift-matches-accrual"))
  await run(byName("last-kick-advanced"))
  await run(byName("gift-reaches-holders"))
}

test("planning never spawns nodeop; the Report carries a runtime capability probe", async () => {
  const { ctx, build } = planned("/does/not/exist"),
    probe = steps(build).find(step => step.name === "probe-kick-crank")
  Assert.ok(probe)
  Assert.deepEqual(phaseNames(build), ["KickerConfigured", "KickerFlowWindow", "KickerValidation", "ManualKick", "CrankKick"])
  await Assert.rejects(probe.runner(ctx, probe.input, new AbortController().signal), /ENOENT/)
})

test("a successful help probe distinguishes option absence from presence", async () => {
  for (const [help, expected] of [["--batch-kick-crank arg (=1)", true], ["--another-option", false]]) {
    const child = fakeNodeop(help), { ctx, build } = planned(child.file), probe = steps(build).find(step => step.name === "probe-kick-crank")
    try {
      const recorder = new StepExtraRecorder()
      await StepExtraRecorder.runWith(recorder, () => probe.runner(ctx, probe.input, new AbortController().signal))
      Assert.equal(ctx.outputs.assert(LIQKickerScenario.CapabilityKey), expected)
      Assert.equal(recorder.calls[0].available, expected)
      Assert.deepEqual(recorder.calls[0].args, ["--help"])
    } finally { child.cleanup() }
  }
})

test("the manual kick is one transaction: lower the minimum, kick, restore it, governance signed by sysio and kick signed by a non-governance actor", async () => {
  const { ctx, build } = planned(null),
    step = steps(build).find(value => value.name === "kick-liqeth"),
    pushed = []
  ctx.wire = {
    getSysioContract: () => ({
      actions: {
        setpool: { prepare: (data, options) => ({ name: "setpool", data, authorization: options.authorization }) },
        kick: { prepare: (data, options) => ({ name: "kick", data, authorization: options.authorization }) }
      }
    }),
    invokeTransaction: async (...actions) => {
      pushed.push(...actions)
      return {
        processed: {
          block_time: LastKickAfter,
          action_traces: [{
            receiver: "sysio.token",
            act: { account: "sysio.token", name: "transfer", data: { from: "sysio", to: "sysio.kicker", quantity: "0.000003805 WIRE" } }
          }]
        }
      }
    }
  }
  await step.runner(ctx, step.input, new AbortController().signal)
  Assert.deepEqual(pushed.map(action => [action.name, action.data.min_gift ?? action.data.sym]), [
    ["setpool", 1], ["kick", "LIQETH"], ["setpool", 1_000_000_000]
  ])
  Assert.deepEqual(pushed.map(action => action.authorization[0].actor), ["sysio", "sysio.kicker", "sysio"])
  Assert.deepEqual(ctx.outputs.assert(LIQKickerScenario.KickReceiptKey), { paid: Gift, blockTime: LastKickAfter })
})

test("the receipt reads the one treasury draw on sysio.token, ignoring notifications and the onward transfer", () => {
  const transfer = (receiver, from, to, quantity) => ({
    receiver, act: { account: "sysio.token", name: "transfer", data: { from, to, quantity } }
  })
  const response = {
    processed: {
      block_time: LastKickAfter,
      action_traces: [
        { receiver: "sysio.kicker", act: { account: "sysio.kicker", name: "kick", data: { sym: "LIQETH" } },
          inline_traces: [
            transfer("sysio.token", "sysio", "sysio.kicker", "0.000003805 WIRE"),
            transfer("sysio", "sysio", "sysio.kicker", "0.000003805 WIRE"),
            transfer("sysio.token", "sysio.kicker", "sysio.liq", "0.000003805 WIRE")
          ] }
      ]
    }
  }
  Assert.deepEqual(kickReceipt(response), { paid: Gift, blockTime: LastKickAfter })
  Assert.throws(
    () => kickReceipt({ processed: { block_time: LastKickAfter, action_traces: [] } }),
    /drew 0 times/
  )
})

test("the manual-kick verifies pass when every ledger moved by the modelled gift", async () => {
  await runManualVerifies({ after }, { paid: Gift, blockTime: LastKickAfter })
})

for (const [fault, patch, receipt, message] of [
  ["paid more than the model", {}, { paid: Gift + 1n, blockTime: LastKickAfter }, /treasury draw is not the modelled gift/],
  ["last_kick short of the block", {}, { paid: Gift, blockTime: "2026-10-10T12:10:01.000" }, /its own block time/],
  ["budget not debited", { config: { budget_remaining: String(Budget), min_interval_sec: 60, twap_window_sec: 60 } }, null, /budget_remaining did not fall/],
  ["yield index not credited", { yieldIndex: null }, null, /yieldidx is not the index/],
  ["treasury not debited", { balances: { ...before.balances } }, null, /treasury \(net of the category buckets\) did not fall/],
  ["minimum not restored", { pool: { ...after.pool, min_gift: 1 } }, null, /did not restore the one-WIRE minimum/]
]) {
  test(`the manual-kick verifies fail when ${fault}`, async () => {
    await Assert.rejects(
      runManualVerifies({ after: { ...after, ...patch } }, receipt ?? { paid: Gift, blockTime: LastKickAfter }),
      message
    )
  })
}


test("holdings stabilization cancels an in-flight read and has a bounded deadline", async () => {
  const controller = new AbortController(), ctx = { wire: { getWireBalance: () => new Promise(() => {}) } },
    pending = readWireHoldings(ctx, controller.signal)
  controller.abort(new Error("cancelled read"))
  await Assert.rejects(pending, /cancelled read/)
  jest.useFakeTimers()
  try {
    const timeout = readWireHoldings(ctx, new AbortController().signal),
      rejected = Assert.rejects(timeout, /did not stabilize/)
    await jest.advanceTimersByTimeAsync(90_001)
    await rejected
  } finally { jest.useRealTimers() }
})

test("all validation cases are named report steps, including removal and warm-up", () => {
  const { build } = planned(null), cases = steps(build).filter(step => step.input?.kind === "LIQKickerScenario.ValidationInput")
  Assert.equal(cases.length, Object.values(LIQKickerScenario.ValidationCase).length)
  Assert.ok(cases.every(step => step.options.timeoutMs > 0))
})

test("crank finality requires LIB and actual inclusion; reversible, orphaned and failed traces cannot pass", async () => {
  const signal = new AbortController().signal,
    state = { pool: before.pool },
    trace = { id: "crank-id", block_time: LastKickAfter, action_traces: [
      { receiver: "sysio.kicker", act: { account: "sysio.kicker", name: "kick", data: { sym: "LIQETH" } } },
      { receiver: "sysio.token", act: { account: "sysio.token", name: "transfer", data: { from: "sysio", to: "sysio.kicker", quantity: "0.000000001 WIRE" } } }
    ] },
    ctx = { wire: {
      getInfo: async () => ({ last_irreversible_block_num: 10 }),
      getTransaction: async () => ({ block_num: 11, block_time: LastKickAfter }),
      getBlock: async () => ({ transactions: [{ trx: { id: "crank-id" } }] })
    } }
  Assert.equal(await LIQKickerScenario.irreversibleCrank(ctx, [trace], state, signal), null)
  ctx.wire.getTransaction = async () => ({ block_num: 10, block_time: LastKickAfter })
  Assert.deepEqual(await LIQKickerScenario.irreversibleCrank(ctx, [trace], state, signal), { paid: 1n, blockTime: LastKickAfter })
  ctx.wire.getBlock = async () => ({ transactions: [] })
  Assert.equal(await LIQKickerScenario.irreversibleCrank(ctx, [trace], state, signal), null)
  Assert.equal(await LIQKickerScenario.irreversibleCrank(ctx, [{ ...trace, except: {} }], state, signal), null)
})


test("the partial-payment oracle prices a historic cumulative observation rather than spot", () => {
  const elapsed = 600_500_000n,
    price = 1n << 64n,
    snapshot = { pool: before.pool, supply: 10_000_000_000n, poolWire: 10_000_000_000n, poolShadow: 10_000_000_000n },
    accumulator = { last_update: LastKickAfter, price1: { hi: "0", lo: String(elapsed * price * 2n) }, price2: { hi: "0", lo: "0" } }
  Assert.equal(expectedGiftAtBlock(snapshot, accumulator, LastKickAfter), 7610n)
  Assert.throws(() => expectedGiftAtBlock(snapshot, { ...accumulator, last_update: "2026-10-10T12:11:00.000" }, LastKickAfter), /mutated after the kick/)
})

test("crank governance runners do no writes when the successful capability probe is negative", async () => {
  const { ctx, build } = planned(null)
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, false)
  ctx.wire = { getSysioContract: () => { throw new Error("unexpected write") } }
  for (const name of ["remove-crank-pool", "add-crank-pool", "cap-crank-budget", "lower-crank-minimum", "restore-min-gift", "restore-crank-budget"]) {
    const step = steps(build).find(step => step.name === name)
    await step.runner(ctx, step.input, new AbortController().signal)
  }
})

for (const paid of [1n, 2n]) test(`the restored budget conserves ${paid} units including rollover recovery`, async () => {
  const { ctx, build } = planned(null), writes = []
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
  ctx.outputs.set(LIQKickerScenario.AfterKickKey, { config: { budget_remaining: String(Budget), min_interval_sec: 60, twap_window_sec: 60 } })
  ctx.outputs.set(LIQKickerScenario.CrankBaselineKey, { pool: { gifted_total: "0" } })
  ctx.wire = { getSysioContract: () => ({
    tables: { kickpools: { query: async () => ({ rows: [{ gifted_total: String(paid) }] }) } },
    actions: { setconfig: { invoke: async data => writes.push(data) } }
  }) }
  const step = steps(build).find(step => step.name === "restore-crank-budget")
  await step.runner(ctx, step.input, new AbortController().signal)
  Assert.equal(BigInt(writes[0].cfg.budget_remaining), Budget - paid)
})

test("snapshot loops stop when balances change forever, and cancel between samples", async () => {
  jest.useFakeTimers()
  let sequence = 0
  const ctx = { wire: { getWireBalance: async () => BigInt(++sequence) } }
  try {
    const pending = readWireHoldings(ctx, new AbortController().signal), rejected = Assert.rejects(pending, /did not stabilize|aborted/)
    await jest.advanceTimersByTimeAsync(90_001)
    await rejected
  } finally { jest.useRealTimers() }
})


test("a kick receipt rejects emissions-accounting writes and token issuance", () => {
  for (const action of [{ account: "sysio", name: "payepoch" }, { account: "sysio.token", name: "issue" }]) {
    Assert.throws(() => kickReceipt({ processed: { block_time: LastKickAfter, action_traces: [{ receiver: action.account, act: action }] } }), /emissions accounting/)
  }
})

function validationContext(state = before) {
  const holder = { state: cloneDeep(state) }, { ctx } = planned(null), reads = fakeWire(holder), calls = []
  ctx.wire = { ...reads, getSysioContract: name => ({
    ...reads.getSysioContract(name), actions: Object.fromEntries(["setconfig", "setemitcfg", "setpool", "addpool", "rmpool", "kick", "pull", "clear", "setpriv", "transfer", "burn", "mint"].map(action => [action, {
      prepare: (data, options) => ({ account: name, name: action, data, authorization: options.authorization })
    }]))
  }), invokeTransaction: async (...actions) => { calls.push(actions); throw new Error("unconfigured mock") } }
  return { ctx, holder, calls }
}

for (const [testCase, expectedError, actionName] of [
  ["windowFloor", "TWAP window must be at least 60 seconds", "setconfig"],
  ["intervalFloor", "minimum interval must be positive", "setconfig"],
  ["budgetBounds", "budget exceeds asset range", "setconfig"],
  ["zeroCap", "invalid daily cap", "setpool"], ["capBelowMinimum", "invalid daily cap", "setpool"], ["capBounds", "invalid daily cap", "setpool"],
  ["rateBounds", "rate exceeds 10000 bps", "setpool"], ["minimumFloor", "invalid minimum gift", "setpool"],
  ["duplicatePool", "pool already configured", "addpool"], ["unknownKick", "unknown kicker pool", "kick"],
  ["unknownSetpool", "unknown kicker pool", "setpool"], ["unknownRmpool", "unknown kicker pool", "rmpool"],
  ["unauthorizedConfig", "missing authority of sysio", "setconfig"], ["unauthorizedAdd", "missing authority of sysio", "addpool"],
  ["unauthorizedSetpool", "missing authority of sysio", "setpool"], ["unauthorizedRemove", "missing authority of sysio", "rmpool"],
  ["inlineRollback", "invalid daily cap", "setpool"], ["inlineFailure", "unsatisfied authorization", "setpriv"]
]) {
  test(`validation ${testCase} invokes its ABI action and checks rejection without a ledger mutation`, async () => {
    const { ctx, calls } = validationContext()
    ctx.wire.invokeTransaction = async (...actions) => { calls.push(actions); throw new Error(expectedError) }
    const step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase[testCase])
    await step.runner(ctx, step.input, new AbortController().signal)
    Assert.equal(calls[0][0].name, actionName)
    if (testCase.startsWith("unauthorized")) Assert.equal(calls[0][0].authorization[0].actor, "sysio.kicker")
  })
}

test("expected-rejection steps fail on success and on an unrelated RPC error", async () => {
  const { ctx } = validationContext(), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.zeroCap), signal = new AbortController().signal
  ctx.wire.invokeTransaction = async () => ({ processed: { action_traces: [] } })
  await Assert.rejects(step.runner(ctx, step.input, signal), /unexpectedly succeeded/)
  ctx.wire.invokeTransaction = async () => { throw new Error("connection refused") }
  await Assert.rejects(step.runner(ctx, step.input, signal), /unexpected zeroCap rejection/)
})

for (const testCase of ["minimumInterval", "belowMinimum", "andonHold", "warmup"]) {
  test(`non-paying ${testCase} preserves every kicker clock and yield ledger`, async () => {
    const state = cloneDeep(before)
    if (testCase === "warmup") state.config = { ...state.config, min_interval_sec: 1, twap_window_sec: 86400 }
    const { ctx } = validationContext(state), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase[testCase])
    ctx.wire.invokeTransaction = async () => ({ processed: { block_time: LastKickAfter, action_traces: [] } })
    await step.runner(ctx, step.input, new AbortController().signal)
  })
}


for (const testCase of ["budgetShortfall", "treasuryShortfall", "capExhausted"]) {
  test(`${testCase} records the exact TWAP-priced unpaid gift without advancing the clock`, async () => {
    const state = cloneDeep(before)
    if (testCase === "capExhausted") {
      state.config.budget_remaining = "0"
      Object.assign(state.pool, { day: Math.floor(Date.parse(LastKickAfter + "Z") / 86400000), spent_today: "1", max_gift_per_day: 1, min_gift: 1 })
    }
    const { ctx, holder, calls } = validationContext(state), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase[testCase])
    ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
    ctx.outputs.set(LIQKickerScenario.CrankClockKey, BigInt(Date.parse(LastKickBefore + "Z")) * 1000n)
    ctx.wire.invokeTransaction = async (...actions) => {
      calls.push(actions)
      if (testCase === "capExhausted") {
        Assert.deepEqual(actions.map(action => action.name), ["setconfig", "kick", "setconfig", "kick", "setconfig"])
        Assert.equal(BigInt(actions[0].data.cfg.budget_remaining), BigInt(state.pool.max_gift_per_day))
        Assert.ok(BigInt(actions[2].data.cfg.budget_remaining) > BigInt(state.pool.max_gift_per_day))
        Assert.equal(BigInt(actions[4].data.cfg.budget_remaining), 0n)
      }
      if (testCase === "treasuryShortfall") {
        Assert.deepEqual(actions.map(action => action.name), ["setemitcfg", "setpool", "kick", "setpool", "setemitcfg"])
        Assert.equal(actions[0].data.cfg.t5_floor, 0)
        Assert.ok(BigInt(actions[0].data.cfg.t5_distributable) > holder.state.balances.sysio)
        // A payepoch landed after the sampled balances. No stale transfer may be submitted.
        holder.state.balances.sysio -= 1000n
        holder.state.balances["sysio.ops"] += 1000n
      }
      holder.state.pool.shortfall_amount = String(Gift)
      holder.state.pool.shortfall_time = LastKickAfter
      return { processed: { block_time: LastKickAfter, action_traces: [] } }
    }
    await step.runner(ctx, step.input, new AbortController().signal)
  })
}

for (const testCase of ["warmupSetup", "zeroSupply"]) {
  test(`${testCase} restores the fixture while resetting the required clock`, async () => {
    const { ctx, holder } = validationContext(), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase[testCase])
    ctx.wire.invokeTransaction = async (...actions) => {
      if (testCase === "zeroSupply") {
        Assert.deepEqual(actions.map(action => action.name), ["setconfig", "transfer", "burn", "kick", "mint", "setconfig"])
        Assert.equal(actions[0].data.cfg.min_interval_sec, 1)
        Assert.deepEqual(actions[5].data.cfg, before.config)
      }
      holder.state.pool.last_kick = LastKickAfter
      if (testCase === "warmupSetup") holder.state.pool.price_time = LastKickAfter
      return { processed: { block_time: LastKickAfter, action_traces: [] } }
    }
    await step.runner(ctx, step.input, new AbortController().signal)
  })
}

test("the window wait uses the chain clock and respects cancellation", async () => {
  const { ctx } = validationContext(), controller = new AbortController()
  ctx.wire.getInfo = async () => ({ head_block_time: LastKickAfter })
  await LIQKickerScenario.runWaitWindow(ctx, controller.signal)
  controller.abort()
  await Assert.rejects(LIQKickerScenario.runWaitWindow(ctx, controller.signal), /abort/i)
})

test("one irreversible crank payment advances a partial clock and every ledger by one unit", async () => {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "kicker-crank-")), logs = Path.join(directory, "logs")
  Fs.mkdirSync(logs)
  const trace = { id: "crank-id", block_time: LastKickAfter, action_traces: [
    { receiver: "sysio.kicker", act: { account: "sysio.kicker", name: "kick", data: { sym: "LIQETH" } } },
    { receiver: "sysio.token", act: { account: "sysio.token", name: "transfer", data: { from: "sysio", to: "sysio.kicker", quantity: "0.000000001 WIRE" } } }
  ] }
  Fs.writeFileSync(Path.join(logs, "cluster_test.log"), `[TRX_TRACE] ${JSON.stringify(trace)}\n`)
  const state = cloneDeep(before), { ctx, holder } = validationContext(state)
  ctx.config.clusterPath = directory
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
  ctx.outputs.set(LIQKickerScenario.CrankBaselineKey, {
    config: { ...before.config, budget_remaining: "1" }, pool: before.pool,
    supply: 10_000_000_000n, poolWire: 10_000_000_000n, poolShadow: 10_000_000_000n,
    yieldIndex: { index: "0", pot: 0, carry: 0 },
    holdings: { treasury: before.balances.sysio, categoryBuckets: 5000n, kicker: 0n }
  })
  holder.state.config.budget_remaining = "0"
  holder.state.pool.gifted_total = "1"
  holder.state.pool.last_kick = "2026-10-10T12:00:00.157"
  holder.state.yieldIndex = { index: "100", pot: "1", carry: "0" }
  holder.state.balances.sysio -= 1n
  ctx.wire.getInfo = async () => ({ last_irreversible_block_num: 10 })
  ctx.wire.getTransaction = async () => ({ block_num: 10, block_time: LastKickAfter })
  ctx.wire.getBlock = async () => ({ transactions: [{ trx: { id: "crank-id" } }] })
  try { await LIQKickerScenario.runVerifyCrank(ctx, new AbortController().signal) }
  finally { Fs.rmSync(directory, { recursive: true, force: true }) }
})


test("flow constants select the minimum TWAP window and fit the bounded crank page", () => {
  const { LIQKickerScenarioConstants: constants } = require("../lib/LIQKickerScenarioConstants.js"), { build } = planned(null)
  Assert.equal(constants.TwapWindowSec, 60)
  Assert.equal(constants.CrankPoolsPerPoll, 10)
  Assert.equal(constants.MinIntervalTimeoutMs, 150000)
  const configuration = steps(build).find(step => step.name === "minimum-twap-window")
  Assert.equal(configuration.input.data.cfg.twap_window_sec, constants.TwapWindowSec)
})


test("bootstrap readback verifies the one-day TWAP window and mandatory cap", async () => {
  const state = cloneDeep(before)
  state.config.twap_window_sec = 86400
  const { ctx, holder } = validationContext(state), { build } = planned(null), step = steps(build).find(step => step.name === "kicker-configured"), signal = new AbortController().signal
  await step.runner(ctx, step.input, signal)
  holder.state.pool.max_gift_per_day = 0
  await Assert.rejects(step.runner(ctx, step.input, signal))
})


test("zero supply precedes the shared funding/manual window; only the crank starts another window", () => {
  const { build } = planned(null), names = steps(build).map(step => step.name)
  Assert.ok(!names.includes("min-interval-elapsed"))
  Assert.ok(names.indexOf("kicker-zeroSupply") < names.indexOf("warmup-elapsed"))
  Assert.ok(names.indexOf("warmup-elapsed") < names.indexOf("kicker-budgetShortfall"))
  Assert.ok(names.indexOf("kicker-treasuryShortfall") < names.indexOf("kick-liqeth"))
  Assert.ok(names.indexOf("kick-liqeth") < names.indexOf("add-crank-pool"))
})

for (const fault of ["treasury", "kicker", "config"]) {
  test(`treasury shortfall detects an unrestored ${fault}`, async () => {
    const { ctx, holder } = validationContext(), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.treasuryShortfall)
    ctx.wire.invokeTransaction = async () => {
      if (fault === "config") holder.state.emissionConfig = { t5_distributable: "0" }
      else holder.state.balances[fault === "treasury" ? "sysio" : "sysio.kicker"] += 1n
      return { processed: { block_time: LastKickAfter, action_traces: [] } }
    }
    await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /restored|conserved/)
  })
}

for (const fault of [null, "extraPayment", "missingRecovery", "shortfall", "budget"]) test(`cap probe recovers UTC rollover during submission and checks recovery (${fault ?? "healthy"})`, async () => {
  const state = cloneDeep(before)
  state.config.budget_remaining = "0"
  Object.assign(state.pool, { day: Math.floor(Date.parse(LastKickBefore + "Z") / 86400000), spent_today: "1", max_gift_per_day: 1, min_gift: 1 })
  const { ctx, holder, calls } = validationContext(state),
    step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.capExhausted),
    blockTime = "2026-10-11T00:00:00.500",
    clock = BigInt(Date.parse(LastKickBefore + "Z")) * 1000n
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
  ctx.outputs.set(LIQKickerScenario.CrankClockKey, clock)
  ctx.wire.invokeTransaction = async (...actions) => {
    calls.push(actions)
    Assert.deepEqual(actions.map(action => action.name), ["setconfig", "kick", "setconfig", "kick", "setconfig"])
    Assert.equal(actions[0].data.cfg.budget_remaining, 1)
    Assert.equal(actions[2].data.cfg.budget_remaining, 2)
    Assert.equal(actions[4].data.cfg.budget_remaining, "0")
    // At the new day's block time the first kick pays the one-unit cap.
    // 43,200.5s accrue 273,788 units; paying one advances 157,788us.
    // The second kick has the same time, enough interval and budget, but no cap.
    Object.assign(holder.state.pool, {
      day: state.pool.day + 1, spent_today: "1", gifted_total: "1",
      last_kick: "2026-10-10T12:00:00.157", shortfall_amount: "273787", shortfall_time: blockTime
    })
    holder.state.balances.sysio -= 1n
    holder.state.yieldIndex = { index: "100", pot: "1", carry: "0" }
    if (fault === "shortfall") holder.state.pool.shortfall_amount = "273788"
    if (fault === "budget") holder.state.config.budget_remaining = "2"
    const transfers = [
      { receiver: "sysio.token", act: { account: "sysio.token", name: "transfer", data: { from: "sysio", to: "sysio.kicker", quantity: "0.000000001 WIRE" } } }
    ]
    return { processed: { block_time: blockTime, action_traces:
      fault === "extraPayment" ? [...transfers, ...transfers] : fault === "missingRecovery" ? [] : transfers
    } }
  }
  const pending = step.runner(ctx, step.input, new AbortController().signal)
  if (fault) {
    await Assert.rejects(pending, /unexpectedly paid|exact unpaid gift|budget_remaining|zero budget/)
    return
  }
  await pending
  Assert.equal(calls.length, 1)
  Assert.equal(ctx.outputs.assert(LIQKickerScenario.CrankClockKey), clock + 157788n)
  Assert.equal(holder.state.config.budget_remaining, "0")
})


test("the positive-budget cap probe fails if an ignored cap pays", async () => {
  const state = cloneDeep(before)
  state.config.budget_remaining = "0"
  Object.assign(state.pool, { day: Math.floor(Date.parse(LastKickAfter + "Z") / 86400000), spent_today: "1", max_gift_per_day: 1, min_gift: 1 })
  const { ctx } = validationContext(state), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.capExhausted)
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
  ctx.wire.invokeTransaction = async () => ({ processed: { block_time: LastKickAfter, action_traces: [
    { receiver: "sysio.token", act: { account: "sysio.token", name: "transfer", data: { from: "sysio", to: "sysio.kicker", quantity: "0.000000001 WIRE" } } }
  ] } })
  await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /capExhausted unexpectedly paid/)
})
