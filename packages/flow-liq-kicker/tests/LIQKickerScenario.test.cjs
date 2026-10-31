const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { cloneDeep } = require("lodash")
const { SysioContracts } = require("@wireio/sdk-core")
const { BindConfigProvider, ClusterBuild, OutputStore, StepExtraRecorder, Steps, WireClient, toURL } = require("@wireio/cluster-tool")
const { LIQKickerScenario, kickReceipt, readWireHoldings, expectedGiftAtBlock, cumulativeAtBlock } = require("../lib/LIQKickerScenario.js")

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

/** One chain state the flow's reads see, in base units. The chain's JSON spells an ABI `bool` as `0` / `1`. */
function chainState({ lastKick, giftedTotal, budget, index, pot, carry, treasury, buckets, minGift }) {
  return {
    config: { budget_remaining: String(budget), min_interval_sec: 60, twap_window_sec: 60, max_spot_deviation_bps: 5000 },
    pool: {
      sym: "LIQETH", rate_bps: 200, min_gift: minGift ?? 1_000_000_000, last_kick: lastKick,
      gifted_total: String(giftedTotal), shortfall_amount: 0, shortfall_time: "1970-01-01T00:00:00.000",
      gift_overflow: 0, spot_deviation: 0, price_time: lastKick, price_snapshot: { hi: "0", lo: String((BigInt(Date.parse(lastKick + "Z") - Date.parse(LastKickBefore + "Z")) * 1000n) << 64n) }, max_gift_per_day: 1_000_000_000_000, day: 0, spent_today: "0", supply_snapshot: "10000000000"
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
  holder.state = holder.before ?? before
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

test("numeric false flags pass bootstrap and paid-kick verification", async () => {
  const state = cloneDeep(before)
  state.config.twap_window_sec = Steps.registry.KickerTwapWindowSec
  Object.assign(state.pool, { spot_deviation: 0, gift_overflow: 0 })
  const { ctx } = validationContext(state), { build } = planned(null),
    step = steps(build).find(step => step.name === "kicker-configured")
  await step.runner(ctx, step.input, new AbortController().signal)
  await runManualVerifies({
    before: { ...before, pool: { ...before.pool, spot_deviation: 0, gift_overflow: 0 } },
    after: { ...after, pool: { ...after.pool, spot_deviation: 0, gift_overflow: 0 } }
  }, { paid: Gift, blockTime: LastKickAfter })
})

test.each([true, 1])("paid-kick spot guard rejects a set flag (%s)", async value => {
  await Assert.rejects(runManualVerifies({
    after: { ...after, pool: { ...after.pool, spot_deviation: value } }
  }, { paid: Gift, blockTime: LastKickAfter }), /the paid kick flagged a spot deviation/)
})

for (const field of ["spot_deviation", "gift_overflow"]) {
  test.each([2, 255, -1, 0.5, "0", "1", "false", "true", "", null, undefined, {}, []])(
    `pool reads reject malformed ${field} (%p)`, async value => {
      const state = cloneDeep(before), { ctx, build } = planned(null),
        step = steps(build).find(step => step.name === "snapshot-before-kick")
      state.pool[field] = value
      ctx.wire = fakeWire({ state })
      await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal),
        new RegExp(`kickpools\\.${field} must be false, true, 0 or 1`))
    }
  )
}

test("SDK table JSON reaches snapshots with only the two safety flags normalized", async () => {
  const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp),
    client = new WireClient({ clusterPath: Os.tmpdir(), binary: Path.join(Os.tmpdir(), "clio"), nodeopUrl: toURL(port), kiodUrl: null }),
    holder = { state: cloneDeep(before) }, reads = fakeWire(holder),
    { ctx, build } = planned(null), step = steps(build).find(step => step.name === "snapshot-before-kick"),
    getSysioContract = client.getSysioContract.bind(client)
  ctx.wire = client
  client.getWireBalance = reads.getWireBalance
  client.getSysioContract = name => name === SysioContracts.SysioContractName.kicker ? getSysioContract(name) : reads.getSysioContract(name)
  const call = jest.spyOn(client.api.v1Provider, "call").mockImplementation(async ({ params }) => {
    const row = String(params.table) === "kickpools" ? holder.state.pool : holder.state.config,
      json = { rows: [{ key: "LIQETH", value: cloneDeep(row) }], more: false }
    return { status: 200, headers: {}, json, text: JSON.stringify(json) }
  })
  try {
    for (const [rawSpot, spot] of [[false, false], [0, false], [true, true], [1, true]]) {
      for (const [rawOverflow, overflow] of [[false, false], [0, false], [true, true], [1, true]]) {
        Object.assign(holder.state.pool, { spot_deviation: rawSpot, gift_overflow: rawOverflow })
        const raw = await client.getSysioContract(SysioContracts.SysioContractName.kicker).tables.kickpools.query()
        Assert.deepEqual(raw.rows[0], holder.state.pool)
        await step.runner(ctx, step.input, new AbortController().signal)
        Assert.deepEqual(ctx.outputs.assert(LIQKickerScenario.BeforeKickKey).pool,
          { ...holder.state.pool, spot_deviation: spot, gift_overflow: overflow })
        Assert.equal(holder.state.pool.spot_deviation, rawSpot)
        Assert.equal(holder.state.pool.gift_overflow, rawOverflow)
      }
    }
  } finally {
    call.mockRestore()
  }
})

for (const [fault, patch, receipt, message] of [
  ["paid more than the model", {}, { paid: Gift + 1n, blockTime: LastKickAfter }, /treasury draw is not the modelled gift/],
  ["last_kick short of the block", {}, { paid: Gift, blockTime: "2026-10-10T12:10:01.000" }, /its own block time/],
  ["budget not debited", { config: { budget_remaining: String(Budget), min_interval_sec: 60, twap_window_sec: 60, max_spot_deviation_bps: 5000 } }, null, /budget_remaining did not fall/],
  ["yield index not credited", { yieldIndex: null }, null, /yieldidx is not the index/],
  ["treasury not debited", { balances: { ...before.balances } }, null, /treasury \(net of the category buckets\) did not fall/],
  ["minimum not restored", { pool: { ...after.pool, min_gift: 1 } }, null, /did not restore the one-WIRE minimum/],
  ["spot deviation flagged", { pool: { ...after.pool, spot_deviation: 1 } }, null, /flagged a spot deviation/]
]) {
  test(`the manual-kick verifies fail when ${fault}`, async () => {
    await Assert.rejects(
      runManualVerifies({ after: { ...after, ...patch } }, receipt ?? { paid: Gift, blockTime: LastKickAfter }),
      message
    )
  })
}


test("the manual-kick verifies fail when the pair's spot strays past the guard from the paid TWAP", async () => {
  // Spot 2.5 against a TWAP of 1.0 is a 150 % deviation; the guard admits 50 %.
  const pumped = { ...before, pair: { pool1: { quantity: "10.000000000 LIQETH" }, pool2: { quantity: "25.000000000 WIRE" } } }
  await Assert.rejects(
    runManualVerifies({ before: pumped, after: { ...after, pair: pumped.pair } }, { paid: Gift, blockTime: LastKickAfter }),
    /strays past the kicker's spot guard/
  )
})

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
  ctx.outputs.set(LIQKickerScenario.AfterKickKey, { config: { budget_remaining: String(Budget), min_interval_sec: 60, twap_window_sec: 60, max_spot_deviation_bps: 5000 } })
  ctx.outputs.set(LIQKickerScenario.CrankBaselineKey, { pool: { gifted_total: "0" } })
  ctx.wire = { getSysioContract: () => ({
    tables: { kickpools: { query: async () => ({ rows: [{ ...before.pool, gifted_total: String(paid) }] }) } },
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
  ["spotDeviationFloor", "spot deviation must be 1 to 10000 bps", "setconfig"],
  ["spotDeviationBounds", "spot deviation must be 1 to 10000 bps", "setconfig"],
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
    if (testCase === "spotDeviationFloor") Assert.equal(calls[0][0].data.cfg.max_spot_deviation_bps, 0)
    if (testCase === "spotDeviationBounds") Assert.equal(calls[0][0].data.cfg.max_spot_deviation_bps, 10_001)
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

for (const testCase of ["warmupSetup", "zeroSupply", "zeroSnapshot"]) {
  test(`${testCase} restores the fixture while resetting the required clock`, async () => {
    const { ctx, holder } = validationContext(), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase[testCase])
    if (testCase === "zeroSnapshot") {
      holder.state.pool.supply_snapshot = "0"
      ctx.outputs.set(LIQKickerScenario.ZeroSupplyConfigKey, cloneDeep(before.config))
      holder.state.config.min_interval_sec = 4_294_967_295
    }
    ctx.wire.invokeTransaction = async (...actions) => {
      if (testCase === "zeroSupply") {
        Assert.deepEqual(actions.map(action => action.name), ["setconfig", "transfer", "burn", "kick", "mint", "setconfig"])
        Assert.equal(actions[0].data.cfg.min_interval_sec, 1)
        Assert.deepEqual(actions[5].data.cfg, { ...before.config, min_interval_sec: 4_294_967_295 })
        holder.state.config.min_interval_sec = 4_294_967_295
      }
      if (testCase === "zeroSnapshot") {
        Assert.deepEqual(actions.map(action => action.name), ["setconfig", "kick", "setconfig"])
        Assert.deepEqual(actions[2].data.cfg, before.config)
        holder.state.config = cloneDeep(before.config)
      }
      holder.state.pool.last_kick = LastKickAfter
      holder.state.pool.supply_snapshot = testCase === "zeroSupply" ? "0" : "10000000000"
      if (testCase === "warmupSetup") holder.state.pool.price_time = LastKickAfter
      return { processed: { block_time: LastKickAfter, action_traces: [] } }
    }
    await step.runner(ctx, step.input, new AbortController().signal)
  })
}

for (const field of ["spot_deviation", "gift_overflow"]) {
  test.each([false, 0, true, 1])(`zero-supply safety assertion preserves ${field} semantics (%s)`, async value => {
    const { ctx, holder } = validationContext(),
      step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.zeroSupply)
    Object.assign(holder.state.pool, { spot_deviation: 0, gift_overflow: 0 })
    ctx.wire.invokeTransaction = async () => {
      holder.state.config.min_interval_sec = 4_294_967_295
      Object.assign(holder.state.pool, { last_kick: LastKickAfter, supply_snapshot: "0", [field]: value })
      return { processed: { block_time: LastKickAfter, action_traces: [] } }
    }
    const pending = step.runner(ctx, step.input, new AbortController().signal)
    if (value === true || value === 1) await Assert.rejects(pending, /true !== false/)
    else await pending
  })
}

test("a rejected action preserves pool state across numeric and boolean JSON reads", async () => {
  const { ctx, holder } = validationContext(),
    step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.zeroCap)
  Object.assign(holder.state.pool, { spot_deviation: 0, gift_overflow: 1 })
  ctx.wire.invokeTransaction = async () => {
    Object.assign(holder.state.pool, { spot_deviation: false, gift_overflow: true })
    throw new Error("invalid daily cap")
  }
  await step.runner(ctx, step.input, new AbortController().signal)
})

test("zeroSnapshot fails when the chain flags gift_overflow as 1", async () => {
  const { ctx, holder } = validationContext(), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.zeroSnapshot)
  holder.state.pool.supply_snapshot = "0"
  ctx.outputs.set(LIQKickerScenario.ZeroSupplyConfigKey, cloneDeep(before.config))
  holder.state.config.min_interval_sec = 4_294_967_295
  ctx.wire.invokeTransaction = async () => {
    holder.state.config = cloneDeep(before.config)
    Object.assign(holder.state.pool, { last_kick: LastKickAfter, supply_snapshot: "10000000000", gift_overflow: 1 })
    return { processed: { block_time: LastKickAfter, action_traces: [] } }
  }
  await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /true !== false/)
})

for (const wait of [LIQKickerScenario.runWaitWindow, LIQKickerScenario.runWaitCheckpoint]) test(`the ${wait.name} wait uses the chain clock and respects cancellation`, async () => {
  const { ctx } = validationContext(), controller = new AbortController()
  ctx.wire.getInfo = async () => ({ head_block_time: LastKickAfter })
  await wait(ctx, controller.signal)
  controller.abort()
  await Assert.rejects(wait(ctx, controller.signal), /abort/i)
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
  // The payment settles the observation at its block: 600.5 s at a 1.0 price.
  holder.state.pool.price_snapshot = after.pool.price_snapshot
  holder.state.pool.price_time = LastKickAfter
  holder.state.yieldIndex = { index: "100", pot: "1", carry: "0" }
  holder.state.balances.sysio -= 1n
  ctx.wire.getInfo = async () => ({ last_irreversible_block_num: 10 })
  ctx.wire.getTransaction = async () => ({ block_num: 10, block_time: LastKickAfter })
  ctx.wire.getBlock = async () => ({ transactions: [{ trx: { id: "crank-id" } }] })
  try {
    await LIQKickerScenario.runVerifyCrank(ctx, new AbortController().signal)
    holder.state.pool.price_snapshot = before.pool.price_snapshot
    holder.state.pool.price_time = LastKickBefore
    await Assert.rejects(
      LIQKickerScenario.runVerifyCrank(ctx, new AbortController().signal),
      /settles the TWAP baseline at its own block/
    )
  }
  finally { Fs.rmSync(directory, { recursive: true, force: true }) }
})

test("the cumulative price at a block extends swap's accumulator at spot, modulo 2^256", () => {
  const price = 1n << 64n,
    snapshot = { poolWire: 10_000_000_000n, poolShadow: 10_000_000_000n },
    accumulator = { last_update: LastKickBefore, price1: { hi: String((1n << 128n) - 1n), lo: String((1n << 128n) - 1n) }, price2: { hi: "0", lo: "0" } }
  Assert.equal(cumulativeAtBlock(snapshot, accumulator, LastKickAfter), price * 600_500_000n - 1n)
  Assert.equal(cumulativeAtBlock(snapshot, { ...accumulator, last_update: LastKickAfter }, LastKickAfter), (1n << 256n) - 1n)
  Assert.throws(() => cumulativeAtBlock(snapshot, { ...accumulator, last_update: "2026-10-10T12:11:00.000" }, LastKickAfter), /mutated after the kick/)
})

test("the crank window wait reads nothing when the crank is unavailable", async () => {
  const ctx = { outputs: new OutputStore(), wire: { getSysioContract: () => { throw new Error("unexpected read") } } }
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, false)
  await LIQKickerScenario.runCrankWindow(ctx, new AbortController().signal)
  ctx.outputs.set(LIQKickerScenario.CapabilityKey, true)
  await Assert.rejects(LIQKickerScenario.runCrankWindow(ctx, new AbortController().signal), /unexpected read/)
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
  holder.state.config.max_spot_deviation_bps = 10000
  await Assert.rejects(step.runner(ctx, step.input, signal))
  holder.state.config.max_spot_deviation_bps = 5000
  holder.state.pool.spot_deviation = 1
  await Assert.rejects(step.runner(ctx, step.input, signal), /true !== false/)
  holder.state.pool.spot_deviation = 0
  holder.state.pool.max_gift_per_day = 0
  await Assert.rejects(step.runner(ctx, step.input, signal))
})


test("zero supply precedes the shared funding/manual window; only the crank starts another window", () => {
  const { build } = planned(null), names = steps(build).map(step => step.name)
  Assert.ok(!names.includes("min-interval-elapsed"))
  Assert.ok(names.indexOf("kicker-zeroSupply") < names.indexOf("warmup-elapsed-zeroSnapshot"))
  Assert.ok(names.indexOf("warmup-elapsed-zeroSnapshot") < names.indexOf("kicker-zeroSnapshot"))
  Assert.ok(names.indexOf("kicker-zeroSnapshot") < names.indexOf("warmup-elapsed-budgetShortfall"))
  Assert.ok(names.indexOf("warmup-elapsed-budgetShortfall") < names.indexOf("kicker-budgetShortfall"))
  Assert.ok(names.indexOf("kicker-treasuryShortfall") < names.indexOf("kick-liqeth"))
  Assert.ok(names.indexOf("kick-liqeth") < names.indexOf("add-crank-pool"))
  Assert.ok(names.indexOf("crank-pays-gift") < names.indexOf("crank-window-elapsed"))
  Assert.ok(names.indexOf("crank-window-elapsed") < names.indexOf("kicker-capExhausted"))
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

for (const fault of [null, "extraPayment", "missingRecovery", "shortfall", "budget", "unsettled"]) test(`cap probe recovers UTC rollover during submission and checks recovery (${fault ?? "healthy"})`, async () => {
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
      last_kick: "2026-10-10T12:00:00.157", shortfall_amount: "273787", shortfall_time: blockTime,
      // The recovery payment settles the observation at its block, a 1.0 price since the baseline.
      price_snapshot: { hi: "0", lo: String(BigInt(Date.parse(blockTime + "Z") - Date.parse(LastKickBefore + "Z")) * 1000n << 64n) },
      price_time: blockTime
    })
    if (fault === "unsettled") Object.assign(holder.state.pool, { price_snapshot: state.pool.price_snapshot, price_time: state.pool.price_time })
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
    await Assert.rejects(pending, /unexpectedly paid|exact unpaid gift|budget_remaining|zero budget|settle the TWAP baseline/)
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

test("the block oracle prices growth at the old snapshot and burns at current supply", () => {
  const snapshot = { pool: before.pool, supply: 20_000_000_000n, poolWire: 10_000_000_000n, poolShadow: 10_000_000_000n },
    accumulator = { last_update: LastKickBefore, price1: { hi: "0", lo: "0" } }
  Assert.equal(expectedGiftAtBlock(snapshot, accumulator, LastKickAfter), Gift)
  Assert.equal(expectedGiftAtBlock({ ...snapshot, supply: 5_000_000_000n }, accumulator, LastKickAfter), 1902n)
  Assert.equal(expectedGiftAtBlock({ ...snapshot, pool: { ...snapshot.pool, supply_snapshot: "0" } }, accumulator, LastKickAfter), 0n)
})

test("full-payment verification uses the old snapshot then checkpoints current supply", async () => {
  const grownBefore = cloneDeep(before), grownAfter = cloneDeep(after)
  grownBefore.supply = grownAfter.supply = "20.000000000 LIQETH"
  grownAfter.pool.supply_snapshot = "20000000000"
  grownAfter.yieldIndex = { index: "190250", pot: 3805, carry: 0 }
  await runManualVerifies({ before: grownBefore, after: grownAfter }, { paid: Gift, blockTime: LastKickAfter })
  grownAfter.pool.supply_snapshot = "10000000000"
  await Assert.rejects(runManualVerifies({ before: grownBefore, after: grownAfter }, { paid: Gift, blockTime: LastKickAfter }), /checkpoint current supply/)
})

for (const [price, checkpoints, window = 60, interval = 60] of [[1n << 64n, true], [1n << 63n, false], [1n << 64n, false, 4_294_967_295], [1n << 64n, false, 60, 4_294_967_295]]) {
  test(`saturated below-minimum probe checks the same TWAP on current supply (${checkpoints}, ${window}, ${interval})`, async () => {
    const state = cloneDeep(before), blockTime = "2026-10-13T12:00:00.000"
    state.config.twap_window_sec = window
    state.config.min_interval_sec = interval
    state.pool.supply_snapshot = "100000000"
    state.pool.min_gift = "1000000"
    const elapsed = 72n * 3600n * 1000000n
    state.accumulator = { last_update: blockTime, price1: { hi: "0", lo: String(elapsed * price) } }
    const { ctx, holder } = validationContext(state), step = LIQKickerScenario.planValidationCase(LIQKickerScenario.ValidationCase.belowMinimum)
    ctx.wire.invokeTransaction = async () => {
      if (checkpoints) Object.assign(holder.state.pool, { supply_snapshot: "10000000000", last_kick: blockTime })
      return { processed: { block_time: blockTime, action_traces: [] } }
    }
    await step.runner(ctx, step.input, new AbortController().signal)
  })
}


test("the checkpoint interval matures at one second while governance and TWAP remain held", async () => {
  const state = cloneDeep(before)
  state.config.min_interval_sec = 4_294_967_295
  const { ctx } = validationContext(state)
  let reads = 0
  ctx.wire.getInfo = async () => {
    Assert.equal(++reads, 1, "checkpoint waited beyond its own one-second interval")
    return { head_block_time: "2026-10-10T12:00:01.000" }
  }
  await LIQKickerScenario.runWaitCheckpoint(ctx, new AbortController().signal)
  Assert.equal(reads, 1)
})
