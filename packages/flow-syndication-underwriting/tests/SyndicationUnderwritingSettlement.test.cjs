const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { test, before, afterEach, mock } = require("node:test")
const {
  BindConfigProvider,
  ClusterBuild,
  KeyGenerator,
  OperatorDaemonTool,
  OutputStore,
  Steps,
  SyndicationScenario,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const { SysioContracts } = require("@wireio/sdk-core")
const {
  SyndicationUnderwritingScenario
} = require("../lib/SyndicationUnderwritingScenario.js")
const {
  SyndicationUnderwritingScenarioConstants: Constants
} = require("../lib/SyndicationUnderwritingScenarioConstants.js")
afterEach(() => mock.restoreAll())

// Sandbox the bind-port registry, as the harness's jest setup does: a unit test neither reads a
// live run's reservations nor writes into the host registry.
process.env[BindConfigProvider.RegistryPathEnvVar] = Fs.mkdtempSync(
  Path.join(Os.tmpdir(), "wire-bind-registry-test-")
)

/** The registry-issued port pair reserved for the underwriter daemon the flow plans. */
let adHocPair
before(async () => {
  adHocPair = {
    http: await BindConfigProvider.findAvailable(
      BindConfigProvider.DefaultAdHocHttp
    ),
    p2p: await BindConfigProvider.findAvailable(
      BindConfigProvider.DefaultAdHocP2p
    )
  }
})

/** The flow's own producer count: every wait on the daemon is sized from it. */
const FinalizerCount = new SyndicationUnderwritingScenario().defaults
  .producerCount

/**
 * What planning and the verify Steps read of the cluster config: the paths, the finalizer
 * count, the signature provider and the reserved ad-hoc port pairs.
 */
function plannedConfig(adHocPairs = [adHocPair]) {
  return {
    clusterPath: "/tmp/unused-unit-cluster",
    dataPath: "/tmp/unused-unit-wallet",
    producerCount: FinalizerCount,
    signatureProvider: { type: KeyGenerator.DefaultKeySource.type },
    bind: { nodeop: { ports: { adHoc: adHocPairs } } }
  }
}

/** Flatten the planned flow so tests exercise the actual verification runner. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

// Per-envelope accounting replaces historical totals without losing exact-amount coverage.
for (const fault of ["none", "first", "second", "wallet", "fees"]) {
  test(`underwriting release checks both envelope amounts and actual credit: ${fault}`, async () => {
    const ctx = {
        outputs: new OutputStore(),
        config: plannedConfig()
      },
      build = ClusterBuild.forContext(ctx),
      fee =
        (Constants.Amount * BigInt(Constants.FeeBps)) /
        SyndicationScenario.BasisPoints
    new SyndicationUnderwritingScenario().plan(build)
    ctx.outputs.set(Constants.Before, { holder: 0n, bonder: 0n, fees: 0n })
    mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) =>
      key === Constants.FirstEpoch
        ? {
            released: Constants.Amount.toString(),
            synd_total: (
              Constants.Amount + (fault === "first" ? 1n : 0n)
            ).toString()
          }
        : {
            synd_total: (
              Constants.LaterAmount + (fault === "second" ? 1n : 0n)
            ).toString(),
            state: SysioContracts.SysioSyndEnvelopeState.REQUESTED,
            request_id: 2
          }
    )
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () => Constants.Amount - fee - (fault === "wallet" ? 1n : 0n)
    )
    mock.method(
      SyndicationScenario,
      "readFees",
      async () => fee + (fault === "fees" ? 1n : 0n)
    )
    const step = steps(build).find(
      value => value.name === "first-released-next-requested"
    )
    Assert.ok(step)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

/** The flow planned on a context that never runs it. */
function plannedFlow(config = plannedConfig()) {
  const build = ClusterBuild.forContext({ outputs: new OutputStore(), config })
  new SyndicationUnderwritingScenario().plan(build)
  return build
}

test("the scenario reserves the port pair its underwriter daemon binds", () => {
  Assert.strictEqual(
    new SyndicationUnderwritingScenario().defaults.adHocCount,
    SyndicationScenario.AdHocDaemonCount
  )
  Assert.throws(() => plannedFlow(plannedConfig([])), /adHocCount/)
})

test("the underwriter daemon starts where the flow first bonded, after the unbonded checks", () => {
  const phases = plannedFlow().children.map(child => child.name)
  Assert.strictEqual(
    phases.indexOf("StartUnderwriter"),
    phases.indexOf("LaterIntake") + 1
  )
  Assert.ok(phases.indexOf("StartUnderwriter") < phases.indexOf("BondFirst"))
  const planned = steps(plannedFlow()),
    start = planned.find(step => step.name === "start-underwriter")
  Assert.strictEqual(
    planned.indexOf(start),
    planned.findIndex(step => step.name === "materialize-underwriter") + 1
  )
  Assert.strictEqual(start.runner, OperatorDaemonTool.runDaemonStart)
  Assert.deepStrictEqual(start.input.daemonOptions, {
    underwriterExposureCaps: [Constants.UnderwriterExposureCap]
  })
})

test("the flow pushes no bond, approve, claim or crank: it waits on the daemon", () => {
  const runners = steps(plannedFlow()).map(step => step.runner)
  ;[
    WireSyndicationTool.runAcceptRemainder,
    WireSyndicationTool.runApproveAfterWindow,
    WireSyndicationTool.runClaimRequest,
    Steps.contracts.sysio.bond.runAccept,
    Steps.contracts.sysio.bond.runApprove,
    Steps.contracts.sysio.bond.runClaim,
    Steps.contracts.sysio.synd.runCrank
  ].forEach(pushed => Assert.ok(!runners.includes(pushed)))
  Assert.strictEqual(
    runners.filter(
      runner => runner === WireSyndicationTool.runAwaitRequestBonded
    ).length,
    3
  )
  Assert.strictEqual(
    runners.filter(
      runner => runner === WireSyndicationTool.runAwaitRequestSettled
    ).length,
    3
  )
})

test("each wait's Step carries the ceiling of what it waits on", () => {
  const ceilings = Object.fromEntries(
    steps(plannedFlow()).map(step => [step.name, step.options.timeoutMs])
  )
  ;["first-bonded", "second-bonded", "unlinked-bonded"].forEach(name =>
    Assert.strictEqual(
      ceilings[name],
      SyndicationScenario.requestBondedOptions(FinalizerCount).timeoutMs
    )
  )
  ;["first-settled", "second-settled", "unlinked-settled"].forEach(name =>
    Assert.strictEqual(
      ceilings[name],
      SyndicationScenario.requestSettledOptions(
        Constants.Config.window_sec,
        FinalizerCount
      ).timeoutMs
    )
  )
  ;[
    "first-released-next-requested",
    "approved-and-returned",
    "second-released",
    "parked-credit"
  ].forEach(name =>
    Assert.strictEqual(
      ceilings[name],
      SyndicationScenario.underwriterPassOptions(FinalizerCount).timeoutMs
    )
  )
})

test("the second release is awaited until the daemon's crank has drained the envelope", async () => {
  const ctx = { outputs: new OutputStore(), config: plannedConfig() },
    step = steps(plannedFlow()).find(value => value.name === "second-released"),
    released = [0n, Constants.LaterAmount],
    read = mock.method(
      SyndicationScenario,
      "readEnvelope",
      async (_ctx, key) => {
        Assert.strictEqual(key, Constants.SecondEpoch)
        return { released: released.shift().toString() }
      }
    )
  await step.runner(ctx, step.input, new AbortController().signal)
  Assert.strictEqual(read.mock.callCount(), 2)
})

test("the cap is exactly the first request's covered amount, so the second request waits for the first bond", () => {
  Assert.strictEqual(Constants.FirstCovered, 2_010_000_000n)
  Assert.strictEqual(Constants.UnderwriterExposureCap, "2.010000000 LIQSOL")
  const cap = SyndicationScenario.units(Constants.UnderwriterExposureCap),
    laterCovered =
      ((Constants.LaterAmount + SyndicationScenario.Increment - 1n) /
        SyndicationScenario.Increment) *
      SyndicationScenario.Increment
  // A later request fits under the cap alone, but not beside the first bond.
  Assert.ok(laterCovered <= cap)
  Assert.ok(Constants.FirstCovered + laterCovered > cap)
})

test("the two intakes before the daemon starts are still proven held", () => {
  const names = steps(plannedFlow()).map(step => step.name)
  Assert.ok(!names.includes("unlinked-held"))
  Assert.ok(
    names.indexOf("later-intake-held") < names.indexOf("start-underwriter")
  )
  Assert.ok(
    names.indexOf("start-underwriter") < names.indexOf("unlinked-intake")
  )
})

test("the third intake is read past the second envelope by its total, released or not", async () => {
  const SecondEpoch = 7,
    ParkedEpoch = 9,
    ParkedRequest = 4,
    ctx = { outputs: new OutputStore(), config: plannedConfig() },
    step = steps(plannedFlow()).find(value => value.name === "unlinked-intake"),
    read = mock.method(WireSyndicationTool, "readIssuedEnvelope", async () => ({
      epoch_index: ParkedEpoch,
      request_id: ParkedRequest,
      state: SysioContracts.SysioSyndEnvelopeState.DONE
    }))
  ctx.outputs.set(Constants.SecondEpoch, SecondEpoch)
  // The unit config holds no envelope artifact, so the circulation check after the capture fails.
  await Assert.rejects(
    step.runner(ctx, step.input, new AbortController().signal),
    /missing decoded syndication/
  )
  Assert.deepStrictEqual(read.mock.calls[0].arguments.slice(1), [
    SyndicationScenario.Chain,
    SyndicationScenario.Token,
    SecondEpoch,
    Constants.LaterAmount
  ])
  Assert.strictEqual(ctx.outputs.assert(Constants.ParkedEpoch), ParkedEpoch)
  Assert.strictEqual(ctx.outputs.assert(Constants.ParkedRequest), ParkedRequest)
})

test("the first release is awaited until the daemon's crank has released it and issued the next request", async () => {
  const ctx = { outputs: new OutputStore(), config: plannedConfig() },
    step = steps(plannedFlow()).find(
      value => value.name === "first-released-next-requested"
    ),
    fee =
      (Constants.Amount * BigInt(Constants.FeeBps)) /
      SyndicationScenario.BasisPoints,
    released = [0n, Constants.Amount]
  ctx.outputs.set(Constants.Before, { holder: 0n, bonder: 0n, fees: 0n })
  let firstReads = 0
  mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) => {
    if (key !== Constants.FirstEpoch)
      return {
        synd_total: Constants.LaterAmount.toString(),
        state: SysioContracts.SysioSyndEnvelopeState.REQUESTED,
        request_id: 2
      }
    firstReads++
    return {
      // Unreleased on the first poll only.
      released: (released.length > 1
        ? released.shift()
        : released[0]
      ).toString(),
      synd_total: Constants.Amount.toString()
    }
  })
  mock.method(
    SyndicationScenario,
    "readBalance",
    async () => Constants.Amount - fee
  )
  mock.method(SyndicationScenario, "readFees", async () => fee)
  await step.runner(ctx, step.input, new AbortController().signal)
  // One unreleased poll, the poll that passes, and the read the assertions make.
  Assert.strictEqual(firstReads, 3)
  Assert.strictEqual(ctx.outputs.assert(Constants.SecondRequest), 2)
})

/** Run the parked-credit check against the parked rows the daemon's crank leaves, poll by poll. */
function verifyParkedCredit({ parked, balance }) {
  const ctx = { outputs: new OutputStore(), config: plannedConfig() },
    step = steps(plannedFlow()).find(value => value.name === "parked-credit"),
    rows = [...parked],
    read = mock.method(WireSyndicationTool, "readParked", async () =>
      rows.length > 1 ? rows.shift() : rows[0]
    )
  mock.method(SyndicationScenario, "publicKey", () => "ab".repeat(32))
  mock.method(SyndicationScenario, "readBalance", async () => balance)
  return step
    .runner(ctx, step.input, new AbortController().signal)
    .then(() => read.mock.callCount())
}
/** The unlinked recipient's syndication less its fee: what the release parks. */
const ParkedCredit =
  Constants.LaterAmount -
  (Constants.LaterAmount * BigInt(Constants.FeeBps)) /
    SyndicationScenario.BasisPoints

test("the parked credit is awaited until the daemon's crank has parked it", async () => {
  Assert.strictEqual(
    await verifyParkedCredit({
      parked: [undefined, { balance: ParkedCredit.toString() }],
      balance: 0n
    }),
    2
  )
})

test("the parked credit is refused when the unlinked account was credited too", async () => {
  await Assert.rejects(
    verifyParkedCredit({
      parked: [{ balance: ParkedCredit.toString() }],
      balance: 1n
    }),
    Assert.AssertionError
  )
})

/** Run the first-claim check against one state of the bonder's balance and its bonds on the second request. */
function verifyClaim({ state, balance, bonds }) {
  const ctx = { outputs: new OutputStore(), config: plannedConfig() },
    step = steps(plannedFlow()).find(
      value => value.name === "approved-and-returned"
    )
  ctx.outputs.set(Constants.Before, { holder: 0n, bonder: Before, fees: 0n })
  ctx.outputs.set(Constants.FirstRequest, 1)
  ctx.outputs.set(Constants.SecondRequest, 2)
  mock.method(WireSyndicationTool, "readRequest", async () => ({
    state,
    bounty: Bounty.toString()
  }))
  mock.method(WireSyndicationTool, "readBonds", async (_ctx, requestId) => {
    Assert.strictEqual(requestId, 2)
    return bonds
  })
  // A second read means the first did not balance: end the poll there.
  let reads = 0
  mock.method(SyndicationScenario, "readBalance", async () => {
    if (reads++ > 0) throw new Error("unbalanced")
    return balance
  })
  return step.runner(ctx, step.input, new AbortController().signal)
}
const Before = 100_000_000_000n,
  Bounty = 7n,
  Stake = 500_000_000n,
  { APPROVED, BONDED } = SysioContracts.SysioBondRequestState,
  stake = (underwriter, paid) => ({
    underwriter,
    paid,
    amount: Stake.toString()
  })

test("the first claim returns the stake and bounty when the daemon has not bonded again", async () => {
  await verifyClaim({ state: APPROVED, balance: Before + Bounty, bonds: [] })
})

test("the first claim counts the daemon's unpaid stake on the second request as the bonder's", async () => {
  await verifyClaim({
    state: APPROVED,
    balance: Before + Bounty - Stake,
    bonds: [stake(SyndicationScenario.Bonder, false)]
  })
})

test("the first claim counts neither a paid stake nor another underwriter's", async () => {
  await Assert.rejects(
    verifyClaim({
      state: APPROVED,
      balance: Before + Bounty - Stake,
      bonds: [stake(SyndicationScenario.Bonder, true)]
    }),
    /unbalanced/
  )
  mock.restoreAll()
  await Assert.rejects(
    verifyClaim({
      state: APPROVED,
      balance: Before + Bounty - Stake,
      bonds: [stake("other.bonder", false)]
    }),
    /unbalanced/
  )
})

test("the first claim is refused until the request is APPROVED", async () => {
  await Assert.rejects(
    verifyClaim({ state: BONDED, balance: Before + Bounty, bonds: [] }),
    Assert.AssertionError
  )
})
