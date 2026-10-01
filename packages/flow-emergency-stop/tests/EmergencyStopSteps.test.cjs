const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { Wallet, Interface, makeError } = require("ethers")
const { KeyType } = require("@wireio/sdk-core")
const {
  AuthExLinkTool,
  EthereumSyndicationTool,
  OutputStore,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  privateKeyFromNativeString
} = require("@wireio/cluster-tool")
const { EmergencyStopSteps } = require("../lib/steps/EmergencyStopSteps.js")
const {
  EmergencyStopScenarioConstants: Constants
} = require("../lib/EmergencyStopScenarioConstants.js")
const { Action, ScriptCommand } = EmergencyStopSteps
const signal = new AbortController().signal
const context = () => ({
  outputs: new OutputStore(),
  wire: {},
  ethereum: { provider: {} }
})
const step = (action, refusal) =>
  EmergencyStopSteps.planAction(
    Report.Actor.User,
    "attempt",
    "one action",
    {},
    action,
    refusal
  )
const run = async (action, ctx = context(), refusal) => {
  const planned = step(action, refusal)
  await planned.runner(ctx, planned.input, signal)
}
afterEach(() => mock.restoreAll())

test("expected refusal is accepted, unexpected refusal and success are rejected", async () => {
  const stub = mock.method(SolanaLiqSyndicationTool, "runSynd", async () => {
    throw new Error("custom program error: 0x17c7")
  })
  await run(Action.synd, context(), "0x17c7")
  Assert.equal(stub.mock.calls.length, 1)
  await Assert.rejects(
    run(Action.synd),
    /Unexpected emergency-stop action refusal/
  )
  stub.mock.mockImplementation(async () => {})
  await Assert.rejects(
    run(Action.synd, context(), "0x17c7"),
    /unexpectedly succeeded/
  )
})

test("Ethereum link carries an EVM wallet matching the imported key", async () => {
  const wallet = Wallet.createRandom(),
    privateKey = privateKeyFromNativeString(KeyType.EM, wallet.privateKey)
  mock.method(Steps.registry, "readMockSyndicationBonder", () => ({
    ethereum: { privateKey: privateKey.toString() }
  }))
  const stub = mock.method(
    AuthExLinkTool,
    "createLink",
    async (_wire, input) => {
      Assert.equal(input.ethereumWallet.address, wallet.address)
      Assert.equal(input.account, SyndicationScenario.Bonder)
    }
  )
  await run(Action.linkEthereum)
  Assert.equal(stub.mock.calls.length, 1)
  stub.mock.mockImplementation(async () => {
    throw new Error("bad link proof")
  })
  await Assert.rejects(
    run(Action.linkEthereum),
    /Unexpected emergency-stop action refusal/
  )
})

test("runtime request is required before payment and the stored id is passed once", async () => {
  const ctx = context(),
    stub = mock.method(
      EthereumSyndicationTool,
      "runPayPendingDesyndication",
      async (_ctx, input) => {
        Assert.equal(input.requestId, 23n)
      }
    )
  await Assert.rejects(
    run(Action.payEthereum, ctx),
    /Unexpected emergency-stop action refusal/
  )
  Assert.equal(stub.mock.calls.length, 0)
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  await run(Action.payEthereum, ctx)
  Assert.equal(stub.mock.calls.length, 1)
})

test("duplicate Ethereum payment accepts only the ABI-decoded duplicate error", async () => {
  const ctx = context(),
    abi = new Interface([
      "error WIRE_NoPendingDesyndication(uint64)",
      "error EnforcedPause()"
    ])
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  mock.method(EthereumSyndicationTool, "loadSyndicationPool", () => ({
    interface: abi
  }))
  const stub = mock.method(
    EthereumSyndicationTool,
    "runPayPendingDesyndication",
    async () => {
      throw makeError("unknown custom error", "CALL_EXCEPTION", {
        data: abi.encodeErrorResult("WIRE_NoPendingDesyndication", [23n])
      })
    }
  )
  await run(Action.payEthereum, ctx, "WIRE_NoPendingDesyndication")
  stub.mock.mockImplementation(async () => {
    throw makeError("unknown custom error", "CALL_EXCEPTION", {
      data: abi.encodeErrorResult("EnforcedPause", [])
    })
  })
  await Assert.rejects(
    run(Action.payEthereum, ctx, "WIRE_NoPendingDesyndication"),
    /Unexpected emergency-stop action refusal/
  )
})

test("read-only script assertions require correct RPC, frozen flag and exact pending identity", () => {
  const rpc = "test-cluster-rpc",
    record = {
      requestId: 23n,
      amount: 42n,
      address: { toBase58: () => "pending-address" }
    }
  EmergencyStopSteps.assertScriptOutput(
    ScriptCommand.status,
    `${rpc}\nfrozen: true`,
    rpc,
    record
  )
  Assert.throws(() =>
    EmergencyStopSteps.assertScriptOutput(
      ScriptCommand.status,
      `${rpc}\nfrozen: false`,
      rpc,
      record
    )
  )
  Assert.throws(() =>
    EmergencyStopSteps.assertScriptOutput(
      ScriptCommand.status,
      "wrong-rpc\nfrozen: true",
      rpc,
      record
    )
  )
  const pending = `${rpc}\nrequest_id=23 amount=42 reason=outpostFrozen pda=pending-address`
  EmergencyStopSteps.assertScriptOutput(
    ScriptCommand.pending,
    pending,
    rpc,
    record
  )
  Assert.throws(() =>
    EmergencyStopSteps.assertScriptOutput(
      ScriptCommand.pending,
      pending.replace("amount=42", "amount=41"),
      rpc,
      record
    )
  )
})

for (const [
  action,
  owner,
  method,
  key,
  value,
  expectedField,
  expectedValue
] of [
  [
    Action.challenge,
    Steps.contracts.sysio.synd,
    "runChallenge",
    Constants.HeldEpoch,
    7,
    "data",
    {
      challenger: SyndicationScenario.Bonder,
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      epoch_index: 7
    }
  ],
  [
    Action.valid,
    Steps.contracts.sysio.bond,
    "runRslvvalid",
    Constants.HeldRequest,
    "23",
    "data",
    { request_id: "23" }
  ],
  [
    Action.claim,
    Steps.contracts.sysio.bond,
    "runClaim",
    Constants.HeldRequest,
    "23",
    "data",
    { request_id: "23", account: SyndicationScenario.Bonder }
  ],
  [
    Action.paySolana,
    SolanaLiqSyndicationTool,
    "runPayPendingDesyndication",
    Constants.Pending,
    { requestId: 23n },
    "requestId",
    23n
  ],
  [
    Action.recreditSolana,
    Steps.contracts.sysio.liq,
    "runRecredit",
    Constants.Shortfall,
    10_000_001n,
    "data",
    { holder: Constants.User.account, quantity: "0.010000001 LIQSOL" }
  ],
  [
    Action.recreditEthereum,
    Steps.contracts.sysio.liq,
    "runRecredit",
    Constants.Shortfall,
    10_000_001n,
    "data",
    { holder: Constants.User.account, quantity: "0.010000001 LIQETH" }
  ],
  [
    Action.donateSolana,
    SolanaLiqSyndicationTool,
    "runDonateToPool",
    Constants.Shortfall,
    10_000_001n,
    "amount",
    10_000_001n
  ],
  [
    Action.donateEthereum,
    EthereumSyndicationTool,
    "runDonateToPool",
    Constants.Shortfall,
    10_000_001n,
    "amount",
    10_000_001_000_000_000n
  ]
]) {
  test(`${action} resolves its runtime input once and refuses an absent output`, async () => {
    const ctx = context(),
      stub = mock.method(owner, method, async (_ctx, input) => {
        Assert.deepEqual(input[expectedField], expectedValue)
      })
    await Assert.rejects(
      run(action, ctx),
      /Unexpected emergency-stop action refusal/
    )
    Assert.equal(stub.mock.calls.length, 0)
    ctx.outputs.set(key, value)
    await run(action, ctx)
    Assert.equal(stub.mock.calls.length, 1)
  })
}

test("scenario plans both causes and outpost-first recovery without executing writes", async () => {
  const { ClusterBuild, WireSyndicationTool } = require("@wireio/cluster-tool")
  const { EmergencyStopScenario } = require("../lib/EmergencyStopScenario.js")
  const ctx = context(),
    cluster = ClusterBuild.forContext(ctx),
    scenario = new EmergencyStopScenario()
  scenario.plan(cluster)
  Assert.equal(scenario.defaults.enableMockSyndicationImport, true)
  Assert.ok(cluster.children.some(child => child.name === "EthereumShortfall"))
  const recovery = cluster.children.find(child => child.name === "Recovery")
  Assert.deepEqual(
    recovery.steps.slice(0, 4).map(value => value.name),
    [
      "frozen-solana-payment-refused",
      "frozen-solana-payment-unchanged",
      "clear-solana",
      "clear-depot"
    ]
  )
  const safety = cluster.children.find(child => child.name === "FinalSafety")
    .steps[0]
  const shortfall = cluster.children.find(
    child => child.name === "AutomaticDepotPull"
  )
  const recoverySteps = [
    "repair-solana-custody",
    "backed-message",
    "backed-intake",
    "repair-message-admitted",
    "clear-shortfall",
    "no-new-mismatch"
  ]
  Assert.deepEqual(
    shortfall.steps
      .map(value => value.name)
      .filter(name => recoverySteps.includes(name)),
    recoverySteps
  )
  ctx.outputs.set(Constants.RecoverySequence, 5n)
  ctx.outputs.set(Constants.Mismatches, [])
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  const cord = mock.method(WireSyndicationTool, "readCord", async () => ({
    pulled: false
  }))
  mock.method(WireSyndicationTool, "readMismatches", async () => [])
  mock.method(
    SolanaLiqSyndicationTool,
    "readGlobalStateFrozen",
    async () => false
  )
  mock.method(SolanaLiqSyndicationTool, "readPendingPayouts", async () => [])
  mock.method(EthereumSyndicationTool, "readPaused", async () => false)
  mock.method(
    EthereumSyndicationTool,
    "readPendingDesyndication",
    async () => undefined
  )
  await safety.runner(ctx, safety.input, signal)
  cord.mock.mockImplementation(async () => ({ pulled: true }))
  await Assert.rejects(safety.runner(ctx, safety.input, signal))
})

test("script pending identity uses complete fields from one record", () => {
  const record = {
    requestId: 23n,
    amount: 42n,
    address: { toBase58: () => "pending-address" }
  }
  Assert.throws(() =>
    EmergencyStopSteps.assertScriptOutput(
      ScriptCommand.pending,
      "test-cluster-rpc\nrequest_id=230 amount=420 reason=outpostFrozen pda=pending-address",
      "test-cluster-rpc",
      record
    )
  )
  Assert.throws(() =>
    EmergencyStopSteps.assertScriptOutput(
      ScriptCommand.pending,
      "test-cluster-rpc\nrequest_id=23 amount=41 reason=outpostFrozen pda=another\nrequest_id=99 amount=42 reason=outpostFrozen pda=pending-address",
      "test-cluster-rpc",
      record
    )
  )
})

test("read-only status accepts terminal color in the packaged script output", () => {
  EmergencyStopSteps.assertScriptOutput(
    ScriptCommand.status,
    "test-cluster-rpc\nfrozen: \u001b[33mtrue\u001b[39m",
    "test-cluster-rpc"
  )
})

for (const sequence of [5n, 6n]) {
  test(`recovery rejects a mismatch at or after boundary: ${sequence}`, () => {
    Assert.throws(
      () =>
        EmergencyStopSteps.assertRecoveryMismatches(
          [
            {
              chain_code: SyndicationScenario.Chain,
              sequence: String(sequence)
            }
          ],
          5n
        ),
      /post-repair/
    )
  })
}
test("recovery keeps earlier mismatch evidence and checks only the repaired outpost boundary", () => {
  const rows = [
    { chain_code: SyndicationScenario.Chain, sequence: "3" },
    { chain_code: SyndicationScenario.Chain, sequence: "4" },
    { chain_code: "ETHEREUM", sequence: "7" }
  ]
  EmergencyStopSteps.assertRecoveryMismatches(rows, 5n)
  Assert.equal(rows.length, 3)
})

test("rejected Ethereum gas estimate releases its reserved nonce before the next write", async () => {
  const {
    resolveLatestNonce,
    clearNonceCache
  } = require("@wireio/cluster-tool")
  const wallet = Wallet.createRandom(),
    signer = {
      getAddress: async () => wallet.address,
      provider: { getTransactionCount: async () => 2 }
    },
    ctx = context(),
    abi = new Interface(["error WIRE_NoPendingDesyndication(uint64)"])
  clearNonceCache(wallet.address)
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  mock.method(EthereumSyndicationTool, "loadSyndicationPool", () => ({
    interface: abi
  }))
  mock.method(
    EthereumSyndicationTool,
    "runPayPendingDesyndication",
    async () => {
      Assert.equal(await resolveLatestNonce(signer), 2)
      throw makeError("unknown custom error", "CALL_EXCEPTION", {
        action: "estimateGas",
        transaction: { from: wallet.address },
        data: abi.encodeErrorResult("WIRE_NoPendingDesyndication", [23n])
      })
    }
  )
  await run(Action.payEthereum, ctx, "WIRE_NoPendingDesyndication")
  Assert.equal(await resolveLatestNonce(signer), 2)
  clearNonceCache(wallet.address)
})

test("probe mismatch identity rejects wrong token, kind or admitted epoch", () => {
  const valid = { token_code: "LIQSOL", kind: "SYNDICATION", epoch_index: 5 }
  EmergencyStopSteps.assertProbeMismatchIdentity(valid, 5)
  for (const wrong of [
    { token_code: "LIQETH" },
    { kind: "YIELD" },
    { epoch_index: 6 }
  ])
    Assert.throws(() =>
      EmergencyStopSteps.assertProbeMismatchIdentity({ ...valid, ...wrong }, 5)
    )
})

test("frozen pending payment requires the exact Solana error code", async () => {
  const ctx = context()
  ctx.outputs.set(Constants.Pending, { requestId: 23n })
  const stub = mock.method(
    SolanaLiqSyndicationTool,
    "runPayPendingDesyndication",
    async () => {
      throw new Error("custom program error: 0x17c7")
    }
  )
  await run(Action.paySolana, ctx, "0x17c7")
  stub.mock.mockImplementation(async () => {
    throw new Error("custom program error: 0x17c70")
  })
  await Assert.rejects(run(Action.paySolana, ctx, "0x17c7"), /Unexpected/)
  stub.mock.mockImplementation(async () => {})
  await Assert.rejects(
    run(Action.paySolana, ctx, "0x17c7"),
    /unexpectedly succeeded/
  )
})

test("paused pending payment requires EnforcedPause from the ABI", async () => {
  const ctx = context(),
    abi = new Interface([
      "error EnforcedPause()",
      "error WIRE_NoPendingDesyndication(uint64)"
    ])
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  mock.method(EthereumSyndicationTool, "loadSyndicationPool", () => ({
    interface: abi
  }))
  const stub = mock.method(
    EthereumSyndicationTool,
    "runPayPendingDesyndication",
    async () => {
      throw makeError("paused", "CALL_EXCEPTION", {
        data: abi.encodeErrorResult("EnforcedPause", [])
      })
    }
  )
  await run(Action.payEthereum, ctx, "EnforcedPause")
  stub.mock.mockImplementation(async () => {
    throw makeError("missing", "CALL_EXCEPTION", {
      data: abi.encodeErrorResult("WIRE_NoPendingDesyndication", [23n])
    })
  })
  await Assert.rejects(
    run(Action.payEthereum, ctx, "EnforcedPause"),
    /Unexpected/
  )
  stub.mock.mockImplementation(async () => {})
  await Assert.rejects(
    run(Action.payEthereum, ctx, "EnforcedPause"),
    /unexpectedly succeeded/
  )
})

test("pre-clear verifications reject changed records or balances on either outpost", async () => {
  const { ClusterBuild } = require("@wireio/cluster-tool")
  const { EmergencyStopScenario } = require("../lib/EmergencyStopScenario.js")
  const ctx = context(),
    cluster = ClusterBuild.forContext(ctx),
    record = { requestId: 23n, amount: 42n }
  new EmergencyStopScenario().plan(cluster)
  ctx.outputs.set(Constants.Pending, record)
  ctx.outputs.set(Constants.BalanceBefore, 42n)
  mock.method(
    SolanaLiqSyndicationTool,
    "readGlobalStateFrozen",
    async () => true
  )
  const solRecord = mock.method(
    SolanaLiqSyndicationTool,
    "readPendingPayout",
    async () => ({ ...record })
  )
  const solBalance = mock.method(
    SolanaLiqSyndicationTool,
    "readLiqsolBalance",
    async () => 42n
  )
  const sol = cluster.children
    .find(p => p.name === "Recovery")
    .steps.find(s => s.name === "frozen-solana-payment-unchanged")
  await sol.runner(ctx, sol.input, signal)
  solRecord.mock.mockImplementation(async () => ({ ...record, amount: 43n }))
  await Assert.rejects(sol.runner(ctx, sol.input, signal))
  solRecord.mock.mockImplementation(async () => ({ ...record }))
  solBalance.mock.mockImplementation(async () => 43n)
  await Assert.rejects(sol.runner(ctx, sol.input, signal))
  const pending = { recipient: "0xholder", depotAmount: 42n, reason: 1 }
  ctx.outputs.set(Constants.EthereumPending, pending)
  ctx.outputs.set(Constants.EthereumRequest, 23n)
  ctx.outputs.set(Constants.EthereumBefore, 42n)
  mock.method(Steps.registry, "readMockSyndicationBonder", () => ({
    ethereum: { address: "0xholder" }
  }))
  mock.method(EthereumSyndicationTool, "readPaused", async () => true)
  const ethRecord = mock.method(
    EthereumSyndicationTool,
    "readPendingDesyndication",
    async () => ({ ...pending })
  )
  const ethBalance = mock.method(
    EthereumSyndicationTool,
    "readLiqEthBalance",
    async () => 42n
  )
  for (const name of ["EthereumPause", "EthereumShortfall"]) {
    const phase = cluster.children.find(p => p.name === name)
    const names = phase.steps.map(s => s.name)
    Assert.ok(
      names.indexOf("paused-ethereum-payment-refused") <
        names.indexOf("unpause-ethereum")
    )
    Assert.ok(
      names.indexOf("paused-ethereum-payment-unchanged") <
        names.indexOf("unpause-ethereum")
    )
    const step = phase.steps.find(
      s => s.name === "paused-ethereum-payment-unchanged"
    )
    ethRecord.mock.mockImplementation(async () => ({ ...pending }))
    ethBalance.mock.mockImplementation(async () => 42n)
    await step.runner(ctx, step.input, signal)
    ethRecord.mock.mockImplementation(async () => ({ ...pending, reason: 2 }))
    await Assert.rejects(step.runner(ctx, step.input, signal))
    ethRecord.mock.mockImplementation(async () => ({ ...pending }))
    ethBalance.mock.mockImplementation(async () => 43n)
    await Assert.rejects(step.runner(ctx, step.input, signal))
  }
})
