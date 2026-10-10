const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { test } = require("node:test")
const { ClusterBuild, OutputStore } = require("@wireio/cluster-tool")
const { LIQKickerScenario, kickReceipt } = require("../lib/LIQKickerScenario.js")

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
    config: { budget_remaining: String(budget), min_interval_sec: 60 },
    pool: {
      sym: "LIQETH", rate_bps: 200, min_gift: minGift ?? 1_000_000_000, last_kick: lastKick,
      gifted_total: String(giftedTotal), shortfall_amount: 0, shortfall_time: "1970-01-01T00:00:00.000",
      gift_overflow: false, max_gift_per_day: 0, day: 0, spent_today: "0"
    },
    supply: "10.000000000 LIQETH",
    pair: { pool1: { quantity: "10.000000000 LIQETH" }, pool2: { quantity: "10.000000000 WIRE" } },
    yieldIndex: index == null ? null : { index: String(index), pot, carry },
    balances: { "sysio": treasury, "sysio.ops": buckets, "sysio.gov": 0n, "sysio.kicker": 0n }
  }
}

/** A `ctx.wire` whose typed tables and balances answer from `state` (mutable between steps). */
function fakeWire(holder) {
  const table = rows => ({ query: async () => ({ rows: rows(), more: false }) })
  return {
    getSysioContract: name => ({
      tables: {
        kicker: { kickcfg: table(() => [holder.state.config]), kickpools: table(() => [holder.state.pool]) },
        liq: {
          stat: table(() => [{ supply: holder.state.supply }]),
          yieldidx: table(() => (holder.state.yieldIndex ? [holder.state.yieldIndex] : []))
        },
        swap: { stat: table(() => [holder.state.pair]) }
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

test("plans the crank phase only when nodeop registers --batch-kick-crank", () => {
  const withCrank = fakeNodeop("  --batch-kick-crank arg (=1)"),
    withoutCrank = fakeNodeop("  --batch-yield-tick-interval-ms arg (=60000)")
  try {
    const crank = planned(withCrank.file).build
    Assert.deepEqual(phaseNames(crank), ["KickerConfigured", "ManualKick", "CrankKick"])
    Assert.deepEqual(
      steps(crank).filter(step => step.input?.kind === "KickerContractSteps.SetpoolInput").map(step => step.input.data.min_gift),
      [1, 1_000_000_000]
    )
    Assert.deepEqual(phaseNames(planned(withoutCrank.file).build), ["KickerConfigured", "ManualKick", "CrankKickUnavailable"])
    Assert.deepEqual(phaseNames(planned(null).build), ["KickerConfigured", "ManualKick", "CrankKickUnavailable"])
  } finally {
    withCrank.cleanup()
    withoutCrank.cleanup()
  }
})

test("the manual kick is one transaction: lower the minimum, kick, restore it, all signed by sysio", async () => {
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
  pushed.forEach(action => Assert.deepEqual(action.authorization, [{ actor: "sysio", permission: "active" }]))
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
  ["budget not debited", { config: { budget_remaining: String(Budget), min_interval_sec: 60 } }, null, /budget_remaining did not fall/],
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
