const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ChainKind } = require("@wireio/opp-typescript-models")
const { Steps, SolanaFundingTool } = require("@wireio/cluster-tool")
const { PrivateKey, KeyType, Base58 } = require("@wireio/sdk-core")
const {
  LcoLaunchSmokeScenario: Scenario
} = require("../lib/LcoLaunchSmokeScenario.js")
afterEach(() => mock.restoreAll())
const solana = PrivateKey.generate(KeyType.ED)
const bonder = {
  ethereum: { address: "0x1234567890123456789012345678901234567890" },
  solana: { publicKey: solana.toPublic().toString() }
}
for (const chain of [ChainKind.EVM, ChainKind.SVM])
  test(`production-format conversion and native import serialize exact entitlement ${chain}`, async () => {
    mock.method(Steps.registry, "readMockSyndicationBonder", () => bonder)
    const ctx = {
      wire: {
        getSysioContract: () => ({
          actions: {
            importseed: {
              invoke: async batch => {
                Assert.equal(batch.credits.length, 1)
                Assert.equal(
                  batch.credits[0].wire_atomic,
                  String(Scenario.Purchased + Scenario.Yield)
                )
                Assert.equal(
                  batch.credits[0].native_address.length,
                  chain === ChainKind.EVM ? 40 : 64
                )
              }
            }
          }
        })
      }
    }
    Assert.equal(
      Scenario.conversion(ctx, chain).batches[0].credits[0].wire_atomic,
      Scenario.Entitlement
    )
    await Scenario.runImport(ctx, { chain }, new AbortController().signal)
  })
test("aborted launch import does not submit a transaction", async () => {
  const controller = new AbortController()
  controller.abort()
  await Assert.rejects(
    Scenario.runImport({}, { chain: ChainKind.EVM }, controller.signal),
    /abort/i
  )
})
test("claim is authorized by the original wallet destination", async () => {
  let action
  const ctx = {
    wire: {
      getSysioContract: () => ({
        actions: { claim: { invoke: async (...args) => (action = args) } }
      })
    }
  }
  await Scenario.runClaim(
    ctx,
    { chain: ChainKind.SVM },
    new AbortController().signal
  )
  Assert.deepEqual(action, [
    { wire_account: "lco.sol" },
    { authorization: [{ actor: "lco.sol", permission: "active" }] }
  ])
})
for (const correct of [true, false])
  test(`original Ethereum wallet must match imported identity: ${correct}`, async () => {
    const {
      EthereumSyndicationTool,
      AuthExLinkTool
    } = require("@wireio/cluster-tool")
    const privateKey = PrivateKey.generate(KeyType.EM).toString(),
      address = "0x1234567890123456789012345678901234567890"
    mock.method(Steps.registry, "readMockSyndicationBonder", () => ({
      ethereum: { address, privateKey }
    }))
    mock.method(EthereumSyndicationTool, "hdWallet", () => ({
      address: correct ? address : "0x9999999999999999999999999999999999999999"
    }))
    let linked = false
    mock.method(AuthExLinkTool, "createLink", async (_wire, params) => {
      Assert.equal(params.account, "lco.eth")
      linked = true
    })
    const run = () =>
      Scenario.runLink(
        { wire: {} },
        { chain: ChainKind.EVM },
        new AbortController().signal
      )
    if (correct) await run()
    else await Assert.rejects(run, /original Ethereum wallet/)
    Assert.equal(linked, correct)
  })
test("close the import window through the actual importdone action", async () => {
  let closed = false
  await Scenario.runImportDone(
    {
      wire: {
        getSysioContract: () => ({
          actions: {
            importdone: {
              invoke: async data => {
                Assert.deepEqual(data, {})
                closed = true
              }
            }
          }
        })
      }
    },
    null,
    new AbortController().signal
  )
  Assert.equal(closed, true)
})
test("aborted import closure cannot submit a transaction", async () => {
  const controller = new AbortController()
  controller.abort()
  await Assert.rejects(
    Scenario.runImportDone({}, null, controller.signal),
    /abort/i
  )
})
