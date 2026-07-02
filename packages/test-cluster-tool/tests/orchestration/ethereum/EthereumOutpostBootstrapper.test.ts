import { EthereumOutpostBootstrapper } from "@wireio/test-cluster-tool/orchestration"
import { BindConfig } from "@wireio/test-cluster-tool/config"
import { toURL } from "@wireio/test-cluster-tool/utils"

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
  const deploymentsPath = "/tmp/cluster/data/ethereum-deployments"
  beforeAll(async () => {
    rpcUrl = toURL(await BindConfig.findAvailable(BindConfig.DefaultAnvil))
  })

  it("throws when ethereumPath is missing", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath
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
          deploymentsPath
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
          deploymentsPath
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
          deploymentsPath: ""
        })
    ).toThrow(/deploymentsPath is required/)
  })
})
