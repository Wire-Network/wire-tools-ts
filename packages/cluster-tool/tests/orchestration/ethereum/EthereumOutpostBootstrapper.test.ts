import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostGenesisRoster
} from "@wireio/cluster-tool/orchestration"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

/** anvil/hardhat account 0 from the `test test … junk` mnemonic — well-known + stable. */
const AnvilAccount0Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const AnvilAccount0PrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

describe("EthereumOutpostBootstrapper.generateAccounts", () => {
  it("generates the requested count deterministically from anvil's mnemonic", () => {
    const accounts = EthereumOutpostBootstrapper.generateAccounts(5)
    expect(accounts).toHaveLength(5)
    expect(accounts[0].address).toBe(AnvilAccount0Address)
    expect(accounts[0].privateKey).toBe(AnvilAccount0PrivateKey)
    expect(accounts[0].usedInBootstrap).toBe(false)
    expect(accounts[0].usedFor).toBe("")
  })

  it("produces distinct addresses per HD index", () => {
    const accounts = EthereumOutpostBootstrapper.generateAccounts(3)
    const addresses = new Set(accounts.map(account => account.address))
    expect(addresses.size).toBe(3)
  })
})

describe("EthereumOutpostBootstrapper constructor", () => {
  let rpcUrl: string
  const deploymentsPath = "/tmp/cluster/data/ethereum-deployments",
    /** A valid WNE-41 genesis roster — one operator, one positive duration. */
    genesisRoster: EthereumOutpostGenesisRoster = {
      groups: [[AnvilAccount0Address]],
      epochDurationSec: 60
    }
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  it("throws when ethereumPath is missing", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath,
          genesisRoster
        })
    ).toThrow(/ethereumPath is required/)
  })

  it("throws when anvilDataPath is missing", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "",
          rpcUrl,
          deploymentsPath,
          genesisRoster
        })
    ).toThrow(/anvilDataPath is required/)
  })

  it("throws when rpcUrl is missing", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl: "",
          deploymentsPath,
          genesisRoster
        })
    ).toThrow(/rpcUrl is required/)
  })

  it("throws when deploymentsPath is missing", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath: "",
          genesisRoster
        })
    ).toThrow(/deploymentsPath is required/)
  })

  // WNE-41 — `OPPInbound.initialize` is one-shot and `isActiveOperator` is
  // fail-closed, so both of these would otherwise produce an outpost whose
  // `epochIn` no address can ever call.
  it("throws when the genesis roster carries no operator", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath,
          genesisRoster: { groups: [[]], epochDurationSec: 60 }
        })
    ).toThrow(/at least one batch-operator address/)
  })

  it("throws when the genesis epochDurationSec is not positive", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath,
          genesisRoster: { groups: [[AnvilAccount0Address]], epochDurationSec: 0 }
        })
    ).toThrow(/epochDurationSec must be positive/)
  })
})
