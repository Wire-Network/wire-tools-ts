const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { Wallet } = require("ethers")
const { KeyType, SlugName, SysioContracts } = require("@wireio/sdk-core")
const {
  AuthExLinkTool,
  Report,
  Steps,
  WireCollateralTool,
  WireReserveTool,
  privateKeyFromNativeString
} = require("@wireio/cluster-tool")
const {
  ProducerCollateralSteps: Collateral
} = require("../lib/ProducerCollateralSteps.js")
const {
  ProducerRegistrationScenario
} = require("../lib/ProducerRegistrationScenario.js")
const {
  ProducerRegistrationScenarioConstants: Constants
} = require("../lib/ProducerRegistrationScenarioConstants.js")
const signal = new AbortController().signal
const account = "prodtest"
const context = wire => ({
  wire,
  keyStore: {
    assertOperator: label => {
      Assert.equal(label, Constants.ProducerLabel)
      return { account }
    }
  }
})
const run = (step, ctx, abort = signal) => step.runner(ctx, step.input, abort)
afterEach(() => mock.restoreAll())

test("producer policy requires exactly 2.0 of BOTH depot shadows", () => {
  const defaults = new ProducerRegistrationScenario().defaults
  Assert.equal(defaults.enableMockSyndicationImport, true)
  Assert.deepEqual(
    defaults.requiredProducerCollateral,
    ["LIQSOL", "LIQETH"].map(token => ({
      chainCode: WireReserveTool.WireChainCode,
      tokenCode: SlugName.from(token),
      minimumBond: 2_000_000_000
    }))
  )
})

test("each funding step transfers the correct shadow under its owner's authority", async () => {
  for (const token of Constants.CollateralTokens) {
    const calls = []
    const ctx = context({
      getSysioContract: contract => {
        Assert.equal(contract, SysioContracts.SysioContractName.liq)
        return {
          actions: { transfer: { invoke: async (...args) => calls.push(args) } }
        }
      }
    })
    const step = Collateral.planFunding(
      Report.Actor.Producer,
      "fund",
      "fund",
      {},
      token
    )
    await run(step, ctx)
    Assert.equal(calls.length, 1)
    Assert.deepEqual(calls[0][0], {
      from: Constants.FundingAccount,
      to: account,
      quantity: `2.000000000 ${token}`,
      memo: "producer collateral funding"
    })
    Assert.equal(
      calls[0][1].authorization[0].actor.toString(),
      Constants.FundingAccount
    )
    Assert.equal(calls[0][1].authorization[0].permission.toString(), "active")
  }
})

test("bond-only steps use depot collateral without WIRE funding", async () => {
  const calls = []
  mock.method(Steps.contracts.sysio.opreg, "runDeposit", async (_ctx, input) =>
    calls.push(input)
  )
  for (const token of Constants.CollateralTokens) {
    const step = Collateral.planDeposit(
      Report.Actor.Producer,
      "bond",
      "bond",
      {},
      token
    )
    Assert.equal(step.runner, WireCollateralTool.runDeposit)
    Assert.equal(
      step.input.collateral.chain_code,
      WireReserveTool.WireChainCode
    )
    await run(step, context({}))
    Assert.deepEqual(calls.at(-1).data, {
      account,
      token_code: token,
      amount: "2000000000"
    })
  }
  Assert.equal(calls.length, 2)
})

test("Ethereum link signs with the imported fixture identity", async () => {
  const wallet = Wallet.createRandom()
  const privateKey = privateKeyFromNativeString(KeyType.EM, wallet.privateKey)
  mock.method(Steps.registry, "readMockSyndicationBonder", () => ({
    ethereum: { privateKey: privateKey.toString() }
  }))
  const link = mock.method(AuthExLinkTool, "createLink", async () => {})
  await run(
    Collateral.planLinkEthereum(Report.Actor.Producer, "link", "link", {}),
    context({})
  )
  const input = link.mock.calls[0].arguments[1]
  Assert.equal(input.account, Constants.FundingAccount)
  Assert.equal(input.ethereumWallet.address, wallet.address)
  Assert.equal(input.privateKey.toString(), privateKey.toString())
})

const balances = (rows, more = false) =>
  context({
    getSysioContract: () => ({
      tables: {
        accounts: {
          query: async query => {
            Assert.equal(query.scope, account)
            return { rows: rows.map(balance => ({ balance })), more }
          }
        }
      }
    })
  })

test("liquid reads distinguish both symbols and absent balances", async () => {
  const ctx = balances(["2.000000000 LIQSOL", "3.000000001 LIQETH"])
  Assert.equal(
    await Collateral.readLiquidBalance(ctx, Constants.CollateralToken.Solana),
    2_000_000_000n
  )
  Assert.equal(
    await Collateral.readLiquidBalance(ctx, Constants.CollateralToken.Ethereum),
    3_000_000_001n
  )
  Assert.equal(
    await Collateral.readLiquidBalance(
      balances([]),
      Constants.CollateralToken.Solana
    ),
    0n
  )
})

test("liquid reads reject incomplete reads and wrong depot precision", async () => {
  await Assert.rejects(
    Collateral.readLiquidBalance(
      balances([], true),
      Constants.CollateralToken.Solana
    ),
    /truncated/
  )
  await Assert.rejects(
    Collateral.readLiquidBalance(
      balances(["2.0000 LIQSOL"]),
      Constants.CollateralToken.Solana
    ),
    /precision/
  )
})

test("payout verification rejects the wrong amount", async () => {
  const step = Collateral.planVerifyLiquidBalance(
    Report.Actor.Producer,
    "payout",
    "payout",
    {},
    Constants.CollateralToken.Ethereum,
    2_000_000_000n
  )
  await run(step, balances(["2.000000000 LIQETH"]))
  await Assert.rejects(
    run(step, balances(["1.999999999 LIQETH"])),
    /liquid balance/
  )
})

test("cancelled writes do not touch keys or chain state", async () => {
  const aborted = AbortSignal.abort(new Error("cancelled"))
  for (const step of [
    Collateral.planFunding(
      Report.Actor.Producer,
      "fund",
      "fund",
      {},
      Constants.CollateralToken.Solana
    ),
    Collateral.planLinkEthereum(Report.Actor.Producer, "link", "link", {})
  ])
    await Assert.rejects(run(step, {}, aborted), /cancelled/)
})
