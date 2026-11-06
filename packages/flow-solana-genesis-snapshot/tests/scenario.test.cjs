const Assert = require("node:assert/strict")
const Fs = require("node:fs")
const Os = require("node:os")
const Path = require("node:path")
const { createHash } = require("node:crypto")
const { test, afterEach, after, before, mock } = require("node:test")
const anchor = require("@coral-xyz/anchor")
const { PublicKey, SystemProgram } = require("@solana/web3.js")
const {
  BindConfigProvider,
  ClusterBuild,
  OutputStore,
  SolanaFundingTool,
  SolanaFixedPriceOracleTool,
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState
} = require("@wireio/cluster-tool")
const { SolanaGenesisSteps: Steps } = require("../lib/SolanaGenesisSteps.js")
const {
  SolanaGenesisSnapshotScenario: Scenario
} = require("../lib/SolanaGenesisSnapshotScenario.js")
const {
  SolanaGenesisSnapshotSchema
} = require("../lib/SolanaGenesisSnapshotSchema.js")
const {
  SolanaGenesisSnapshotConstants: Constants
} = require("../lib/SolanaGenesisSnapshotConstants.js")

const temporary = Fs.mkdtempSync(
  Path.join(Os.tmpdir(), "solana-genesis-flow-unit-")
)
const originalCapitalPath = process.env[Constants.CapitalIndexPathEnvironment]
const originalRegistry = process.env.WIRE_BIND_REGISTRY_PATH
let endpoint
before(async () => {
  process.env.WIRE_BIND_REGISTRY_PATH = Path.join(temporary, "bind-registry")
  endpoint = `http://127.0.0.1:${await BindConfigProvider.findAvailable()}`
})
afterEach(() => {
  mock.restoreAll()
  if (originalCapitalPath == null)
    delete process.env[Constants.CapitalIndexPathEnvironment]
  else process.env[Constants.CapitalIndexPathEnvironment] = originalCapitalPath
})
after(() => {
  if (originalRegistry == null) delete process.env.WIRE_BIND_REGISTRY_PATH
  else process.env.WIRE_BIND_REGISTRY_PATH = originalRegistry
  Fs.rmSync(temporary, { recursive: true, force: true })
})
const key = n => new PublicKey(Buffer.alloc(32, n))
const number = n => new anchor.BN(n.toString())
const flattened = node =>
  node.steps ? [...node.steps] : node.children.flatMap(flattened)

function fixture() {
  return {
    active: {
      address: key(1).toBase58(),
      principal: 2000000000n,
      purchased: 1000000000n,
      directPretokens: 10000000000n,
      stakedShares: 2000000000n,
      purchasedShares: 1000000000n
    },
    exited: {
      address: key(2).toBase58(),
      principal: 1000000000n,
      purchased: 0n,
      directPretokens: 0n,
      stakedShares: 1000000000n,
      purchasedShares: 0n
    },
    readyEpoch: 10
  }
}

function context() {
  const result = {
    outputs: new OutputStore(),
    config: { dataPath: temporary, solanaPath: "unused-by-mocked-addresses" },
    solana: {
      connection: {
        rpcEndpoint: endpoint,
        getEpochInfo: async () => ({ epoch: 12 })
      }
    }
  }
  const base = Object.fromEntries(
    [
      "globalState",
      "globalConfig",
      "poolAuthority",
      "distributionState",
      "bucketAuthority",
      "liqsolMint",
      "liqsolMintAuthority",
      "extraAccountMetaList",
      "liqsolPoolAta",
      "liqsolPoolUserRecord",
      "bucketTokenAccount",
      "bucketUserRecord",
      "reservePool",
      "depositAuthority",
      "vault",
      "stakeControllerState",
      "payoutState",
      "payRateHistory",
      "outpostConfig",
      "outboundMessageBuffer",
      "liqsolCoreProgram",
      "liqsolTokenProgram",
      "transferHookProgram"
    ].map((name, index) => [name, key(index + 10)])
  )
  mock.method(SolanaLiqSyndicationTool, "deriveBasePdas", () => base)
  mock.method(SolanaLiqSyndicationTool, "deriveUserPdas", (_path, user) => ({
    ...base,
    user,
    userAta: key(4),
    userUserRecord: key(5),
    outpostAccount: SolanaOutpostProgramTool.derivePda(
      base.liqsolCoreProgram,
      Buffer.from("outpost_account"),
      user.toBuffer()
    )
  }))
  mock.method(SolanaFundingTool, "loadKeypair", (_path, name) => ({
    publicKey: name === Constants.ExitedUser ? key(2) : key(1)
  }))
  result.outputs.set(Steps.FixtureKey, fixture())
  result.outputs.set(Steps.RoundsKey, [
    { purchasedPretokens: 40000000001n, purchaseEpoch: 11 },
    { purchasedPretokens: 20000000001n, purchaseEpoch: 12 }
  ])
  return result
}

function artifact(ctx) {
  const state = ctx.outputs.assert(Steps.FixtureKey)
  const rounds = ctx.outputs.assert(Steps.RoundsKey)
  const activePdas = Steps.addresses(ctx, key(1))
  const balances = [state.active, state.exited]
    .map((user, index) => {
      const pdas = Steps.addresses(ctx, key(index + 1))
      const earned = Scenario.expectedYield(user, state, rounds)
      return {
        address: user.address,
        outpostAccount: pdas.outpostAccount.toBase58(),
        pretokenRecord: index === 0 ? pdas.userPretokenRecord.toBase58() : null,
        syndicatedLiqsol: index === 0 ? "2000000000" : "0",
        purchasedLiqsol: user.purchased.toString(),
        stakedShares: index === 0 ? "2000000000" : "0",
        purchasedShares: user.purchasedShares.toString(),
        directlyPurchasedPretokens: user.directPretokens.toString(),
        pretokenYield: earned.toString(),
        totalPretokens: (user.directPretokens + earned).toString()
      }
    })
    .sort((a, b) => (a.address < b.address ? -1 : 1))
  const allocationHash = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        programId: activePdas.liqsolCoreProgram.toBase58(),
        balances
      })
    )
    .digest("hex")
  return {
    schemaVersion: 1,
    programId: activePdas.liqsolCoreProgram.toBase58(),
    allocationHash,
    balances,
    accounting: {
      wireState: "Launching",
      mode: "genesis",
      epoch: "12",
      poolAuthority: activePdas.poolAuthority.toBase58(),
      poolBalance: "4000000000",
      poolPretokens: "60000000002",
      allocatedPretokenYield: "60000000000",
      unallocatedPoolPretokens: "2",
      directlyPurchasedPretokens: "10000000000",
      totalUserPretokens: "70000000000",
      totalPretokensSold: "70000000002",
      ownerlessShares: "100",
      unreportedLiqsolYield: "100000000",
      backingAvailable: "3900000000",
      initialChainAmount: "1000000000",
      issues: [],
      warnings: ["2 pool pretokens remain unallocated"],
      units: {
        liqsolDecimals: 9,
        pretokenDecimals: 8,
        indexScale: "1000000000000"
      }
    },
    evidence: [
      {
        address: activePdas.globalState.toBase58(),
        owner: activePdas.liqsolCoreProgram.toBase58(),
        slot: 10,
        dataBase64: "AA=="
      }
    ]
  }
}

test("plans all real writes separately and exports immediately after transaction finality, before the epoch wait", () => {
  const ctx = context()
  const scenario = new Scenario()
  Assert.equal(scenario.defaults.enableSolanaFixedPriceOracle, true)
  const build = ClusterBuild.forContext(ctx)
  scenario.plan(build)
  const steps = flattened(build)
  const names = steps.map(step => step.name)
  Assert.ok(
    names.indexOf("record-fixture-positions") <
      names.indexOf("purchase-first-yield-pretokens")
  )
  Assert.ok(
    names.indexOf("materialize-active-yield") <
      names.indexOf("purchase-terminal-yield-pretokens")
  )
  Assert.ok(
    names.indexOf("fully-exit-second-user") < names.indexOf("enter-launching")
  )
  Assert.deepEqual(names.slice(names.indexOf("enter-launching")), [
    "enter-launching",
    "launching-transaction-finalized",
    "export-immediate-genesis",
    "assert-genesis-allocations",
    "await-later-finalized-epoch",
    "export-later-genesis",
    "assert-frozen-determinism"
  ])
  const writes = steps.filter(step => step.runner === Steps.runWrite)
  Assert.equal(writes.length, 8)
  const exportSteps = steps.filter(step => step.runner === Steps.runExport)
  Assert.deepEqual(
    exportSteps.map(step => step.input.expectRefusal),
    [true, false, false]
  )
})

test("oracle evidence requires actual CPI queries and rejects the development bypass", async () => {
  const ctx = context()
  ctx.outputs.set(Steps.OraclePurchaseSignatureKey, "purchase-signature")
  const oracle = SolanaFixedPriceOracleTool.ProgramId.toBase58()
  let logs = [
    `Program ${oracle} invoke [2]`,
    `Program ${oracle} success`,
    `Program ${oracle} invoke [2]`,
    `Program ${oracle} success`
  ]
  let error = null
  ctx.solana.connection.getTransaction = async (signature, options) => {
    Assert.equal(signature, "purchase-signature")
    Assert.equal(options.commitment, "confirmed")
    return { meta: { err: error, logMessages: logs } }
  }
  await Steps.assertOracleCpi(ctx)
  logs = []
  await Assert.rejects(
    () => Steps.assertOracleCpi(ctx),
    /both round data and decimals/
  )
  logs = [
    `Program ${oracle} invoke [2]`,
    `Program ${oracle} invoke [2]`,
    "Program log: Using mock SOL/USD price (feature: development)"
  ]
  await Assert.rejects(
    () => Steps.assertOracleCpi(ctx),
    /development oracle bypass/
  )
  error = { InstructionError: [0, "InvalidAccountData"] }
  await Assert.rejects(
    () => Steps.assertOracleCpi(ctx),
    /purchase must succeed/
  )
})

test("expected entitlements use controlled constant principal and floor EACH actual purchase", () => {
  const state = fixture()
  const rounds = [
    { purchasedPretokens: 5n, purchaseEpoch: 11 },
    { purchasedPretokens: 5n, purchaseEpoch: 12 }
  ]
  Assert.equal(Scenario.expectedYield(state.active, state, rounds), 6n)
  Assert.equal(Scenario.expectedYield(state.exited, state, rounds), 2n)
  Assert.equal(Scenario.expectedYield(state.active, state, []), 0n)
  const empty = {
    ...state,
    active: { ...state.active, principal: 0n, purchased: 0n },
    exited: { ...state.exited, principal: 0n }
  }
  Assert.throws(
    () => Scenario.expectedYield(empty.active, empty, rounds),
    /must be positive/
  )
})

test("real prelaunch account maps bind the owner and history; every instruction has its required optional surface", () => {
  const ctx = context()
  const pdas = Steps.addresses(ctx, key(1))
  Assert.ok(!pdas.userPretokenRecord.equals(pdas.poolPretokenRecord))
  Assert.equal(
    Steps.addresses(ctx, key(2)).poolPretokenRecord.toBase58(),
    pdas.poolPretokenRecord.toBase58()
  )
  Assert.ok(
    !Steps.addresses(ctx, key(2)).userPretokenRecord.equals(
      pdas.userPretokenRecord
    )
  )
  for (const instruction of Object.values(Steps.Instruction)) {
    const accounts = Steps.instructionAccounts(instruction, pdas)
    Assert.equal(
      accounts.systemProgram.toBase58(),
      SystemProgram.programId.toBase58()
    )
    if (instruction !== Steps.Instruction.initTrancheState)
      Assert.equal(
        accounts.pretokenPurchaseHistory,
        pdas.pretokenPurchaseHistory
      )
  }
  const synd = Steps.instructionAccounts(Steps.Instruction.synd, pdas)
  for (const instruction of [
    Steps.Instruction.initTrancheState,
    Steps.Instruction.purchase,
    Steps.Instruction.purchaseFromYield
  ]) {
    const accounts = Steps.instructionAccounts(instruction, pdas)
    Assert.ok(
      accounts.chainlinkProgram.equals(SolanaFixedPriceOracleTool.ProgramId)
    )
    Assert.ok(accounts.chainlinkFeed.equals(SolanaFixedPriceOracleTool.FeedId))
    Assert.ok(!accounts.chainlinkProgram.equals(SystemProgram.programId))
  }
  Assert.equal(synd.outpostAccount, pdas.outpostAccount)
  Assert.equal(synd.config, null)
  Assert.equal(synd.outboundMessageBuffer, null)
  Assert.equal(
    Steps.instructionAccounts(Steps.Instruction.purchaseFromYield, pdas)
      .poolPretokenRecord,
    pdas.poolPretokenRecord
  )
  Assert.equal(
    Steps.instructionAccounts(Steps.Instruction.desynd, pdas)
      .receiverUserRecord,
    pdas.userUserRecord
  )
  Assert.equal(
    Steps.instructionAccounts(Steps.Instruction.finalizeOutpostAccount, pdas)
      .payer,
    key(1).equals(pdas.user) ? pdas.user : null
  )
  Assert.throws(() => Steps.instructionAccounts("notAnInstruction", pdas))
})

test("external snapshot schema rejects wrong units, phase, precision and incomplete artifacts", () => {
  const ctx = context()
  Assert.deepEqual(
    SolanaGenesisSnapshotSchema.parse(artifact(ctx)),
    artifact(ctx)
  )
  for (const change of [
    x => {
      x.accounting.units.pretokenDecimals = 9
    },
    x => {
      x.accounting.mode = "preview"
    },
    x => {
      x.accounting.wireState = "PreLaunch"
    },
    x => {
      x.balances[0].pretokenYield = "1.5"
    },
    x => {
      x.evidence = []
    },
    x => {
      x.accounting.maxInitialChainAmount = x.accounting.initialChainAmount
      delete x.accounting.initialChainAmount
    },
    x => {
      delete x.accounting.warnings
    }
  ]) {
    const value = artifact(ctx)
    change(value)
    Assert.throws(() => SolanaGenesisSnapshotSchema.parse(value))
  }
})

test("reads use the deployed IDL and tolerate a missing optional purchase record", async () => {
  const ctx = context()
  const decoded = { value: number(42) }
  const calls = []
  ctx.solana.connection.getAccountInfo = async () => ({
    data: Buffer.from([1])
  })
  mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({
    coder: {
      accounts: {
        decode: (name, data) => {
          calls.push([name, data])
          return decoded
        }
      }
    }
  }))
  Assert.equal(await Steps.readAccount(ctx, key(1), "someAccount"), decoded)
  Assert.equal(calls[0][0], "someAccount")
  ctx.solana.connection.getAccountInfo = async () => null
  Assert.equal(await Steps.readAccount(ctx, key(1), "someAccount"), undefined)
})

test("fixture capture checks real staked principal and nonzero direct purchases before rewards", async () => {
  const ctx = context()
  const state = fixture()
  mock.method(Scenario, "readFixtureUser", async (_ctx, name) =>
    name === Constants.ActiveUser ? state.active : state.exited
  )
  await Scenario.recordFixture(ctx)
  Assert.equal(ctx.outputs.assert(Steps.FixtureKey).readyEpoch, 12)
  state.exited.principal = 0n
  await Assert.rejects(() => Scenario.recordFixture(ctx))
})

test("wallet fixture reads preserve shares and actual spend; a missing position fails", async () => {
  const ctx = context()
  mock.method(Steps, "readAccount", async (_ctx, _address, name) =>
    name === "outpostAccount"
      ? {
          stakedLiqsol: number(2),
          stakedShares: number(3),
          purchasedLiqsol: number(4),
          purchasedShares: number(5)
        }
      : undefined
  )
  const user = await Scenario.readFixtureUser(ctx, Constants.ActiveUser)
  Assert.deepEqual(
    [
      user.principal,
      user.stakedShares,
      user.purchased,
      user.purchasedShares,
      user.directPretokens
    ],
    [2n, 3n, 4n, 5n, 0n]
  )
  mock.method(Steps, "readAccount", async () => undefined)
  await Assert.rejects(
    () => Scenario.readFixtureUser(ctx, Constants.ActiveUser),
    /missing real outpost position/
  )
})

test("observes only actual pool purchase deltas and rejects a no-op or a wrong epoch denominator", async () => {
  const ctx = context()
  ctx.outputs.set(Steps.RoundsKey, [])
  const history = {
    latestEpoch: number(11),
    startingEpoch: number(10),
    syndPerEpoch: [number(4000000000n)]
  }
  let total = 10n
  mock.method(Steps, "readAccount", async (_ctx, _address, name) =>
    name === "userPretokenRecord"
      ? { totalPretokensPurchased: number(total) }
      : history
  )
  await Scenario.recordRound(ctx)
  Assert.deepEqual(ctx.outputs.assert(Steps.RoundsKey), [
    { purchasedPretokens: 10n, purchaseEpoch: 11 }
  ])
  await Assert.rejects(() => Scenario.recordRound(ctx), /must be nonzero/)
  total = 20n
  history.latestEpoch = number(12)
  history.syndPerEpoch.push(number(1))
  await Assert.rejects(
    () => Scenario.recordRound(ctx),
    /complete controlled positions/
  )
})

test("on-chain materialization must equal the independent first purchase entitlement", async () => {
  const ctx = context()
  ctx.outputs.set(Steps.RoundsKey, [
    { purchasedPretokens: 40000000000n, purchaseEpoch: 11 }
  ])
  let stored = 30000000000n
  mock.method(Steps, "readAccount", async () => ({
    accumulatedPretokenYield: number(stored)
  }))
  await Scenario.assertMaterialized(ctx)
  stored++
  await Assert.rejects(() => Scenario.assertMaterialized(ctx))
})

test("immediate verification catches dropped exited users, wrong asset amounts, double-counted yield and false hashes", async () => {
  const ctx = context()
  mock.method(Steps, "readAccount", async () => ({
    accumulatedPretokenYield: number(30000000000n)
  }))
  mock.method(
    SolanaLiqSyndicationTool,
    "readPoolBalance",
    async () => 4000000000n
  )
  mock.method(SolanaLiqSyndicationTool, "readLiqYieldState", async () => ({
    yieldAccumulatedLiqsol: 100000000n
  }))
  ctx.outputs.set(Steps.FirstSnapshotKey, artifact(ctx))
  await Scenario.assertImmediateSnapshot(ctx)
  for (const change of [
    x => {
      x.accounting.epoch = "13"
    },
    x => x.balances.pop(),
    x => {
      x.balances[0].pretokenYield = "300000000"
    },
    x => {
      x.balances[0].totalPretokens = (
        BigInt(x.balances[0].totalPretokens) * 2n
      ).toString()
    },
    x => {
      x.allocationHash = "a".repeat(64)
    },
    x => {
      x.accounting.ownerlessShares = "0"
    },
    x => {
      x.accounting.poolBalance = "0"
    },
    x => {
      x.accounting.initialChainAmount = "1900000000"
    }
  ]) {
    const value = artifact(ctx)
    change(value)
    ctx.outputs.set(Steps.FirstSnapshotKey, value)
    await Assert.rejects(() => Scenario.assertImmediateSnapshot(ctx))
  }
})

test("determinism requires a later finalized epoch AND identical balances and hash", async () => {
  const ctx = context()
  const first = artifact(ctx),
    later = structuredClone(first)
  later.accounting.epoch = "13"
  ctx.outputs
    .set(Steps.FirstSnapshotKey, first)
    .set(Steps.LaterSnapshotKey, later)
  await Scenario.assertDeterministic(ctx)
  later.allocationHash = "a".repeat(64)
  await Assert.rejects(() => Scenario.assertDeterministic(ctx))
  later.allocationHash = first.allocationHash
  later.accounting.epoch = "12"
  await Assert.rejects(() => Scenario.assertDeterministic(ctx))
})

test("epoch waits select confirmed for fixture setup and finalized only AFTER the first export", async () => {
  const ctx = context(),
    calls = []
  ctx.outputs.set(Steps.FirstSnapshotKey, artifact(ctx))
  ctx.solana.connection.getEpochInfo = async commitment => {
    calls.push(commitment)
    return { epoch: 13 }
  }
  await Scenario.assertPositionEpochPassed(ctx)
  await Scenario.assertFirstRoundEpochPassed(ctx)
  await Scenario.assertExportEpochPassed(ctx)
  Assert.deepEqual(calls, ["confirmed", "confirmed", "finalized"])
  const aborted = new AbortController()
  aborted.abort()
  await Assert.rejects(
    () =>
      Steps.runWrite(
        ctx,
        { instruction: Steps.Instruction.synd },
        aborted.signal
      ),
    /abort/i
  )
})

test("Launching gate requests finalized account data, using the real IDL enum spelling", async () => {
  const ctx = context(),
    calls = []
  ctx.solana.connection.getAccountInfo = async (...args) => {
    calls.push(args)
    return { data: Buffer.from([1]) }
  }
  mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({
    coder: { accounts: { decode: () => ({ wireState: { launching: {} } }) } }
  }))
  await Steps.assertLaunchingFinalized(ctx)
  Assert.equal(calls[0][1], "finalized")
  ctx.solana.connection.getAccountInfo = async () => {
    throw new Error("RPC unavailable")
  }
  await Assert.rejects(
    () => Steps.assertLaunchingFinalized(ctx),
    /RPC unavailable/
  )
})

test("export prerequisites reject a missing or unbuilt external checkout", () => {
  delete process.env[Constants.CapitalIndexPathEnvironment]
  Assert.throws(() => Steps.capitalIndexPath(), /set WIRE_CAPITAL_INDEX_PATH/)
  process.env[Constants.CapitalIndexPathEnvironment] = temporary
  Assert.throws(() => Steps.capitalIndexPath(), /build capital-index first/)
})

test("transaction runner submits exactly one real instruction and refuses zero token amounts", async () => {
  const ctx = context(),
    calls = []
  const builder = {
    accountsStrict(accounts) {
      calls.push(["accounts", accounts])
      return this
    },
    preInstructions(instructions) {
      calls.push(["budget", instructions])
      return this
    },
    async transaction() {
      return "one-transaction"
    }
  }
  mock.method(SolanaLiqSyndicationTool, "loadLiqsolProgram", () => ({
    methods: {
      purchase: (...args) => {
        calls.push(["method", args])
        return builder
      }
    }
  }))
  ctx.solana.connection.sendTransaction = async (transaction, signers) => {
    calls.push(["send", transaction, signers])
    return "signature"
  }
  ctx.solana.connection.getSignatureStatus = async () => ({
    value: { confirmationStatus: "confirmed", err: null }
  })
  const input = {
    kind: "SolanaGenesisSteps.WriteInput",
    instruction: Steps.Instruction.purchase,
    userName: Constants.ActiveUser,
    amount: 100n
  }
  await Steps.runWrite(ctx, input, new AbortController().signal)
  Assert.equal(calls.filter(([name]) => name === "send").length, 1)
  Assert.equal(calls[0][1][0].toString(), "100")
  Assert.equal(calls.find(([name]) => name === "send")[1], "one-transaction")
  await Assert.rejects(
    () =>
      Steps.runWrite(
        ctx,
        { ...input, amount: 0n },
        new AbortController().signal
      ),
    /positive amount/
  )
})

test("external process Step passes the local endpoint/program, validates output and refuses overwrites", async () => {
  const ctx = context()
  const root = Path.join(temporary, "external-checkout")
  Fs.mkdirSync(Path.join(root, "scripts"), { recursive: true })
  Fs.mkdirSync(Path.join(root, "dist", "opp"), { recursive: true })
  Fs.writeFileSync(
    Path.join(root, "dist", "opp", "solana-opp-snapshot.service.js"),
    ""
  )
  Fs.writeFileSync(
    Path.join(root, "fixture.json"),
    JSON.stringify(artifact(ctx))
  )
  Fs.writeFileSync(
    Path.join(root, "scripts", "export-solana-genesis.js"),
    `
    const Fs = require('node:fs'), Path = require('node:path');
    const output = process.argv[process.argv.indexOf('--output') + 1];
    if (output.includes('refused')) { process.stderr.write('Genesis requires finalized Launching state, got PreLaunch'); process.exit(1); }
    Fs.writeFileSync(Path.join(process.cwd(), 'observed-environment.json'), JSON.stringify({
      endpoint: process.env.HELIUS_RPC_URL, program: process.env.SOLANA_OPP_PROGRAM_ID, global: process.env.SOLANA_OPP_GLOBAL_STATE
    }));
    Fs.copyFileSync(Path.join(process.cwd(), 'fixture.json'), output);
  `
  )
  process.env[Constants.CapitalIndexPathEnvironment] = root
  Assert.equal(Steps.capitalIndexPath(), root)
  const input = {
    kind: "SolanaGenesisSteps.ExportInput",
    fileName: "unit-export.json",
    output: Steps.FirstSnapshotKey,
    expectRefusal: false
  }
  const signal = new AbortController().signal
  await Steps.runExport(ctx, input, signal)
  Assert.deepEqual(ctx.outputs.assert(Steps.FirstSnapshotKey), artifact(ctx))
  const observed = JSON.parse(
    Fs.readFileSync(Path.join(root, "observed-environment.json"), "utf8")
  )
  Assert.equal(observed.endpoint, endpoint)
  Assert.equal(
    observed.program,
    SolanaLiqSyndicationTool.deriveBasePdas().liqsolCoreProgram.toBase58()
  )
  await Assert.rejects(
    () => Steps.runExport(ctx, input, signal),
    /refuse to overwrite/
  )
  await Steps.runExport(
    ctx,
    { ...input, fileName: "unit-refused.json", expectRefusal: true },
    signal
  )
  const aborted = new AbortController()
  aborted.abort()
  await Assert.rejects(
    () => Steps.runExport(ctx, input, aborted.signal),
    /abort/i
  )
})

test("pre-state guard rejects a reused cluster before fixture writes", async () => {
  const ctx = context()
  ctx.solana.connection.getAccountInfo = async () => null
  mock.method(Steps, "readAccount", async () => ({
    totalStakedLiqsol: number(0),
    totalPurchasedLiqsol: number(0),
    totalShares: number(0)
  }))
  mock.method(Steps, "capitalIndexPath", () => temporary)
  mock.method(
    SolanaLiqSyndicationTool,
    "readWireState",
    async () => WireState.preLaunch
  )
  await Scenario.assertPrerequisites(ctx)
  ctx.solana.connection.getAccountInfo = async () => ({
    data: Buffer.from([1])
  })
  await Assert.rejects(
    () => Scenario.assertPrerequisites(ctx),
    /already have a tranche/
  )
  ctx.solana.connection.getAccountInfo = async () => null
  mock.method(
    SolanaLiqSyndicationTool,
    "readWireState",
    async () => WireState.postLaunch
  )
  await Assert.rejects(
    () => Scenario.assertPrerequisites(ctx),
    /fresh PreLaunch/
  )
})
