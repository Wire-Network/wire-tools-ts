import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostInitialRoster
} from "@wireio/cluster-tool/orchestration"
import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

/** anvil/hardhat account 0 from the `test test … junk` mnemonic — well-known + stable. */
const AnvilAccount0Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const AnvilAccount0PrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
/** anvil accounts 1 and 2 — distinct roster members for the seed cases. */
const AnvilAccount1Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const AnvilAccount2Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
/** The depot's epoch duration for the seed cases. */
const SeedEpochDurationSec = 60

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
    /** A valid WNE-41 initial roster — one operator, one positive duration. */
    initialRoster: EthereumOutpostInitialRoster = {
      groups: [[AnvilAccount0Address]],
      epochDurationSec: ClusterConfigProvider.DefaultEpochDurationSec
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
          initialRoster
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
          initialRoster
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
          initialRoster
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
          initialRoster
        })
    ).toThrow(/deploymentsPath is required/)
  })

  // WNE-41 — `OPPInbound.initialize` is one-shot and `isActiveOperator` is
  // fail-closed, so both of these would otherwise produce an outpost whose
  // `epochIn` no address can ever call.
  it("throws when the initial roster carries no operator", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath,
          initialRoster: {
            groups: [[]],
            epochDurationSec: ClusterConfigProvider.DefaultEpochDurationSec
          }
        })
    ).toThrow(/at least one batch-operator address/)
  })

  it("throws when the initial epochDurationSec is not positive", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper({
          ethereumPath: "/repo/eth",
          anvilDataPath: "/tmp/anvil",
          rpcUrl,
          deploymentsPath,
          initialRoster: { groups: [[AnvilAccount0Address]], epochDurationSec: 0 }
        })
    ).toThrow(/epochDurationSec must be positive/)
  })
})

describe("EthereumOutpostBootstrapper.initialBatchOperatorGroups", () => {
  /** A seed over `groups`, epoch-1 slot `activeGroupIndex`. */
  const seed = (
    groups: string[][],
    activeGroupIndex = 0,
    epochDurationSec = SeedEpochDurationSec
  ): EthereumOutpostBootstrapper.OppBootstrapSeed => ({
    window: { groups, epochDurationSec },
    activeGroupIndex
  })

  it("builds the BatchOperatorGroups tuple: EVM-kinded, checksummed, anchored at epoch 0", () => {
    const tuple = EthereumOutpostBootstrapper.initialBatchOperatorGroups(
      seed([[AnvilAccount1Address.toLowerCase()], [AnvilAccount2Address, AnvilAccount1Address]], 1)
    )
    expect(tuple).toEqual({
      activeGroupIndex: 1,
      epochIndex: EthereumOutpostBootstrapper.InitialRosterAnchorEpochIndex,
      groups: [
        { operators: [{ kind: ChainKind.EVM, address_: AnvilAccount1Address }] },
        {
          operators: [
            { kind: ChainKind.EVM, address_: AnvilAccount2Address },
            { kind: ChainKind.EVM, address_: AnvilAccount1Address }
          ]
        }
      ],
      epochDurationSec: SeedEpochDurationSec
    })
    expect(EthereumOutpostBootstrapper.InitialRosterAnchorEpochIndex).toBe(0)
  })

  it("allows the same operator in DIFFERENT slots — one operator serving consecutive epochs", () => {
    const tuple = EthereumOutpostBootstrapper.initialBatchOperatorGroups(
      seed([[AnvilAccount1Address], [AnvilAccount1Address]])
    )
    expect(tuple.groups).toHaveLength(2)
  })

  it("rejects what OPPInbound._installInitialRoster rejects, with a readable reason", () => {
    for (const [groups, reason] of [
      [[], /at least one batch-operator group/],
      [[[]], /group 0 is empty/],
      [[[AnvilAccount1Address], []], /group 1 is empty/],
      [[["not-an-address"]], /group 0 member 'not-an-address' is not an EVM address/],
      [[[ethers.ZeroAddress]], /group 0 contains the zero address/],
      [
        [[AnvilAccount1Address, AnvilAccount1Address.toLowerCase()]],
        /appears twice in group 0/
      ]
    ] as const) {
      expect(() =>
        EthereumOutpostBootstrapper.initialBatchOperatorGroups(seed([...groups.map(group => [...group])]))
      ).toThrow(reason)
    }
  })

  it("rejects a non-positive epoch duration and an out-of-range active slot", () => {
    expect(() =>
      EthereumOutpostBootstrapper.initialBatchOperatorGroups(seed([[AnvilAccount1Address]], 0, 0))
    ).toThrow(/epochDurationSec must be a positive integer/)
    expect(() =>
      EthereumOutpostBootstrapper.initialBatchOperatorGroups(seed([[AnvilAccount1Address]], 1))
    ).toThrow(/activeGroupIndex 1 is out of range for 1 group/)
  })
})

describe("EthereumOutpostBootstrapper.oppBootstrap", () => {
  let rpcUrl: string, deploymentsPath: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })
  beforeEach(() => {
    deploymentsPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-opp-bootstrap-"))
  })
  afterEach(() => {
    Fs.rmSync(deploymentsPath, { recursive: true, force: true })
  })

  it("refuses to seed before the outpost deploy has written its address map", async () => {
    // The seed runs in EpochBootstrap, long after `deploy-ethereum`; a missing
    // address map means the phases were reordered, not that there is nothing
    // to seed — fail loudly rather than skip like the reserve seeding does.
    const window: EthereumOutpostInitialRoster = {
      groups: [[AnvilAccount1Address]],
      epochDurationSec: SeedEpochDurationSec
    }
    const bootstrapper = new EthereumOutpostBootstrapper({
      ethereumPath: "/repo/eth",
      anvilDataPath: Path.join(deploymentsPath, "anvil"),
      rpcUrl,
      deploymentsPath,
      initialRoster: window
    })
    await expect(
      bootstrapper.oppBootstrap({ window, activeGroupIndex: 0 })
    ).rejects.toThrow(/outpost-addrs\.json is missing — the Ethereum outpost deploy must precede the roster seed/)
  })

  it("validates the seed before touching the chain", async () => {
    Fs.writeFileSync(
      Path.join(deploymentsPath, EthereumOutpostBootstrapper.OutpostAddressesFile),
      JSON.stringify({ OutpostManager: AnvilAccount0Address, OPPInbound: AnvilAccount1Address })
    )
    const window: EthereumOutpostInitialRoster = {
      groups: [[AnvilAccount1Address]],
      epochDurationSec: SeedEpochDurationSec
    }
    const bootstrapper = new EthereumOutpostBootstrapper({
      ethereumPath: "/repo/eth",
      anvilDataPath: Path.join(deploymentsPath, "anvil"),
      rpcUrl,
      deploymentsPath,
      initialRoster: window
    })
    // An out-of-range active slot fails in the tuple builder — no provider,
    // no artifact read, no RPC.
    await expect(
      bootstrapper.oppBootstrap({ window, activeGroupIndex: 3 })
    ).rejects.toThrow(/activeGroupIndex 3 is out of range/)
  })
})

describe("EthereumOutpostBootstrapper deploy configs", () => {
  const rpcUrl = "http://anvil.invalid",
    deploymentsPath = "/tmp/cluster/data/ethereum-deployments",
    roster: EthereumOutpostInitialRoster = {
      groups: [[AnvilAccount1Address]],
      epochDurationSec: SeedEpochDurationSec
    },
    /** The panic account, derived independently of the code under test. */
    panicAccount = ethers.HDNodeWallet.fromPhrase(
      EthereumOutpostBootstrapper.AnvilMnemonic,
      undefined,
      `${EthereumOutpostBootstrapper.DerivationPath}${EthereumOutpostBootstrapper.PanicAccountIndex}`
    ).address

  it("reserves the last prefunded anvil account for the panic account", () => {
    expect(EthereumOutpostBootstrapper.PanicAccountIndex).toBe(49)
    // Clear of the deployer and of every index the flows name (35–47) and the
    // swap users (32 up).
    expect(EthereumOutpostBootstrapper.PanicAccountIndex).toBeGreaterThan(47)
    expect(
      EthereumOutpostBootstrapper.anvilWallet(
        EthereumOutpostBootstrapper.PanicAccountIndex
      ).address
    ).toBe(panicAccount)
    expect(EthereumOutpostBootstrapper.anvilWallet(0).address).toBe(
      AnvilAccount0Address
    )
  })

  it("writes the outpost config with the three syndication keys as decimal strings", () => {
    const config = EthereumOutpostBootstrapper.outpostDeployConfig(
      rpcUrl,
      AnvilAccount0PrivateKey,
      deploymentsPath,
      panicAccount,
      roster
    )
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      url: rpcUrl,
      key: AnvilAccount0PrivateKey,
      addressFile: Path.join(deploymentsPath, "outpost-addrs.json"),
      gasLimitFile: Path.join(deploymentsPath, "outpost-gas-limits.json"),
      useMockAggregator: true,
      initialOperatorGroups: [[AnvilAccount1Address]],
      epochDurationSec: SeedEpochDurationSec,
      panicAccount,
      // deployOutpost.ts accepts digits only; 1,000 liqETH in wei and 0.01
      // liqETH in depot units.
      maxSyndicationPerTransfer: "1000000000000000000000",
      yieldDeadband: "10000000"
    })
    expect(ethers.parseEther("1000").toString()).toBe(
      config.maxSyndicationPerTransfer
    )
  })

  it("writes the liqETH config with the panic account every DeployScript grants", () => {
    expect(
      JSON.parse(
        JSON.stringify(
          EthereumOutpostBootstrapper.liqEthDeployConfig(
            rpcUrl,
            AnvilAccount0PrivateKey,
            deploymentsPath,
            panicAccount
          )
        )
      )
    ).toEqual({
      url: rpcUrl,
      key: AnvilAccount0PrivateKey,
      addressFile: Path.join(deploymentsPath, "liqeth-addrs.json"),
      gasLimitFile: Path.join(deploymentsPath, "liqeth-gas-limits.json"),
      entryQueue: 47,
      dailyRateBPS: 283,
      rewardCooldown: 100,
      withdrawalDelay: 50,
      panicAccount
    })
  })

  it("keeps the two address files the deploy clears before every run", () => {
    expect([...EthereumOutpostBootstrapper.StaleDeployArtifactFiles]).toEqual([
      "liqeth-addrs.json",
      "outpost-addrs.json"
    ])
  })
})

describe("EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount", () => {
  it("accepts every roster whose operator indices stay below the panic account", () => {
    // emissions-soak's 21 batch operators + 1 underwriter reach index 22.
    expect(() =>
      EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(21, 1)
    ).not.toThrow()
    expect(() =>
      EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(3, 0)
    ).not.toThrow()
    // The last free index: 45 + 3 + 1 = 49 is the panic account's, 48 is not.
    expect(() =>
      EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(45, 3)
    ).not.toThrow()
  })

  it("refuses a roster whose last operator lands on the panic account", () => {
    expect(() =>
      EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(45, 4)
    ).toThrow(/reach HD index 49, which is not below the panic account's 49/)
    expect(() =>
      EthereumOutpostBootstrapper.assertOperatorsClearOfPanicAccount(49, 0)
    ).toThrow(/not below the panic account's/)
  })
})
