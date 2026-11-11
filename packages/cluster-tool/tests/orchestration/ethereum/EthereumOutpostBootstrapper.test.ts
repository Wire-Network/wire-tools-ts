import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { KeyType } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostBootstrapperOptions,
  type EthereumOutpostInitialRoster
} from "@wireio/cluster-tool/orchestration"
import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import {
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyHex,
  toURL
} from "@wireio/cluster-tool/utils"

/** A random EM pair — the shape the Ethereum outpost phase persists for the deployer and the panic account. */
const randomKeyPair = (): EthereumKeyPair =>
  ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
/** Two distinct roster members for the seed cases. */
const RosterMemberA = ethers.Wallet.createRandom().address
const RosterMemberB = ethers.Wallet.createRandom().address
/** The depot's epoch duration for the seed cases. */
const SeedEpochDurationSec = 60

describe("EthereumOutpostBootstrapper constructor", () => {
  let rpcUrl: string
  const deploymentsPath = "/tmp/cluster/data/ethereum-deployments",
    /** A valid WNE-41 initial roster — one operator, one positive duration. */
    initialRoster: EthereumOutpostInitialRoster = {
      groups: [[RosterMemberA]],
      epochDurationSec: ClusterConfigProvider.DefaultEpochDurationSec
    }
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  /** Every option valid, with `overrides` replacing the ones a case invalidates. */
  function options(
    overrides: Partial<EthereumOutpostBootstrapperOptions> = {}
  ): EthereumOutpostBootstrapperOptions {
    return {
      ethereumPath: "/repo/eth",
      rpcUrl,
      deploymentsPath,
      initialRoster,
      deployer: randomKeyPair(),
      panicAccount: randomKeyPair(),
      ...overrides
    }
  }

  it("accepts a complete option set", () => {
    expect(() => new EthereumOutpostBootstrapper(options())).not.toThrow()
  })

  it("throws when ethereumPath is missing", () => {
    expect(
      () => new EthereumOutpostBootstrapper(options({ ethereumPath: "" }))
    ).toThrow(/ethereumPath is required/)
  })

  it("throws when rpcUrl is missing", () => {
    expect(
      () => new EthereumOutpostBootstrapper(options({ rpcUrl: "" }))
    ).toThrow(/rpcUrl is required/)
  })

  it("throws when deploymentsPath is missing", () => {
    expect(
      () => new EthereumOutpostBootstrapper(options({ deploymentsPath: "" }))
    ).toThrow(/deploymentsPath is required/)
  })

  it("throws when the deployer wallet is missing — the deploy has nobody to sign as", () => {
    expect(
      () => new EthereumOutpostBootstrapper(options({ deployer: undefined }))
    ).toThrow(/deployer wallet \(with its private key\) is required/)
  })

  it("throws when the deployer pair carries no private key — a refs-only pair cannot sign the deploy", () => {
    const { privateKey: _secret, ...refsOnly } = randomKeyPair()
    expect(
      () =>
        new EthereumOutpostBootstrapper(
          options({
            deployer: { ...refsOnly, awsSecretId: "/wire/test/deployer/EM" }
          })
        )
    ).toThrow(/deployer wallet \(with its private key\) is required/)
  })

  it("throws when the panic account wallet is missing — the deploy config must name it", () => {
    expect(
      () => new EthereumOutpostBootstrapper(options({ panicAccount: undefined }))
    ).toThrow(/panic account wallet is required/)
  })

  // WNE-41 — `OPPInbound.initialize` is one-shot and `isActiveOperator` is
  // fail-closed, so both of these would otherwise produce an outpost whose
  // `epochIn` no address can ever call.
  it("throws when the initial roster carries no operator", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper(
          options({
            initialRoster: {
              groups: [[]],
              epochDurationSec: ClusterConfigProvider.DefaultEpochDurationSec
            }
          })
        )
    ).toThrow(/at least one batch-operator address/)
  })

  it("throws when the initial epochDurationSec is not positive", () => {
    expect(
      () =>
        new EthereumOutpostBootstrapper(
          options({
            initialRoster: { groups: [[RosterMemberA]], epochDurationSec: 0 }
          })
        )
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
      seed(
        [[RosterMemberA.toLowerCase()], [RosterMemberB, RosterMemberA]],
        1
      )
    )
    expect(tuple).toEqual({
      activeGroupIndex: 1,
      epochIndex: EthereumOutpostBootstrapper.InitialRosterAnchorEpochIndex,
      groups: [
        {
          operators: [{ kind: ChainKind.EVM, address_: RosterMemberA }]
        },
        {
          operators: [
            { kind: ChainKind.EVM, address_: RosterMemberB },
            { kind: ChainKind.EVM, address_: RosterMemberA }
          ]
        }
      ],
      epochDurationSec: SeedEpochDurationSec
    })
    expect(EthereumOutpostBootstrapper.InitialRosterAnchorEpochIndex).toBe(0)
  })

  it("allows the same operator in DIFFERENT slots — one operator serving consecutive epochs", () => {
    const tuple = EthereumOutpostBootstrapper.initialBatchOperatorGroups(
      seed([[RosterMemberA], [RosterMemberA]])
    )
    expect(tuple.groups).toHaveLength(2)
  })

  it("rejects what OPPInbound._installInitialRoster rejects, with a readable reason", () => {
    for (const [groups, reason] of [
      [[], /at least one batch-operator group/],
      [[[]], /group 0 is empty/],
      [[[RosterMemberA], []], /group 1 is empty/],
      [
        [["not-an-address"]],
        /group 0 member 'not-an-address' is not an EVM address/
      ],
      [[[ethers.ZeroAddress]], /group 0 contains the zero address/],
      [
        [[RosterMemberA, RosterMemberA.toLowerCase()]],
        /appears twice in group 0/
      ]
    ] as const) {
      expect(() =>
        EthereumOutpostBootstrapper.initialBatchOperatorGroups(
          seed([...groups.map(group => [...group])])
        )
      ).toThrow(reason)
    }
  })

  it("rejects a non-positive epoch duration and an out-of-range active slot", () => {
    expect(() =>
      EthereumOutpostBootstrapper.initialBatchOperatorGroups(
        seed([[RosterMemberA]], 0, 0)
      )
    ).toThrow(/epochDurationSec must be a positive integer/)
    expect(() =>
      EthereumOutpostBootstrapper.initialBatchOperatorGroups(
        seed([[RosterMemberA]], 1)
      )
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
    deploymentsPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "eth-opp-bootstrap-")
    )
  })
  afterEach(() => {
    Fs.rmSync(deploymentsPath, { recursive: true, force: true })
  })

  /** A bootstrapper over `window`, signing as a random deployer. */
  function bootstrapper(
    window: EthereumOutpostInitialRoster
  ): EthereumOutpostBootstrapper {
    return new EthereumOutpostBootstrapper({
      ethereumPath: "/repo/eth",
      rpcUrl,
      deploymentsPath,
      initialRoster: window,
      deployer: randomKeyPair(),
      panicAccount: randomKeyPair()
    })
  }

  it("refuses to seed before the outpost deploy has written its address map", async () => {
    // The seed runs in EpochBootstrap, long after `deploy-ethereum`; a missing
    // address map means the phases were reordered, not that there is nothing
    // to seed — fail loudly rather than skip like the reserve seeding does.
    const window: EthereumOutpostInitialRoster = {
      groups: [[RosterMemberA]],
      epochDurationSec: SeedEpochDurationSec
    }
    await expect(
      bootstrapper(window).oppBootstrap({ window, activeGroupIndex: 0 })
    ).rejects.toThrow(
      /outpost-addrs\.json is missing — the Ethereum outpost deploy must precede the roster seed/
    )
  })

  it("validates the seed before touching the chain", async () => {
    Fs.writeFileSync(
      Path.join(
        deploymentsPath,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      ),
      JSON.stringify({
        OutpostManager: ethers.Wallet.createRandom().address,
        OPPInbound: RosterMemberB
      })
    )
    const window: EthereumOutpostInitialRoster = {
      groups: [[RosterMemberA]],
      epochDurationSec: SeedEpochDurationSec
    }
    // An out-of-range active slot fails in the tuple builder — no provider,
    // no artifact read, no RPC.
    await expect(
      bootstrapper(window).oppBootstrap({ window, activeGroupIndex: 3 })
    ).rejects.toThrow(/activeGroupIndex 3 is out of range/)
  })
})

describe("EthereumOutpostBootstrapper deploy configs", () => {
  const rpcUrl = "http://anvil.invalid",
    deploymentsPath = "/tmp/cluster/data/ethereum-deployments",
    roster: EthereumOutpostInitialRoster = {
      groups: [[RosterMemberA]],
      epochDurationSec: SeedEpochDurationSec
    },
    /** The random deployer the outpost phase persisted; the deploy scripts take its `0x` secret. */
    deployer = randomKeyPair(),
    deployerPrivateKey = ethereumPrivateKeyHex(deployer),
    /** The random panic account, named by address only. */
    panicAccount = randomKeyPair().address

  it("hands the deploy scripts the deployer's 0x secret — the key behind the stored PVT_EM_ pair", () => {
    expect(deployer.type).toBe(KeyType.EM)
    expect(deployerPrivateKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(new ethers.Wallet(deployerPrivateKey).address).toBe(deployer.address)
  })

  it("writes the outpost config signed by the deployer, naming the panic account, with the three syndication keys as decimal strings", () => {
    const config = EthereumOutpostBootstrapper.outpostDeployConfig(
      rpcUrl,
      deployerPrivateKey,
      deploymentsPath,
      panicAccount,
      roster
    )
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(deploymentsPath, "outpost-addrs.json"),
      gasLimitFile: Path.join(deploymentsPath, "outpost-gas-limits.json"),
      useMockAggregator: true,
      initialOperatorGroups: [[RosterMemberA]],
      epochDurationSec: SeedEpochDurationSec,
      panicAccount,
      // deployOutpost.ts accepts digits only; 1,000 liqETH in wei and 0.01
      // liqETH in depot units.
      maxSyndicationPerTransfer: "1000000000000000000000",
      yieldDeadband: "10000000",
      mockSyndicatedPrincipal: "0"
    })
    expect(ethers.parseEther("1000").toString()).toBe(
      config.maxSyndicationPerTransfer
    )
  })

  it("keeps the deployer OUT of the initial operator groups — deployment privilege is not delivery privilege", () => {
    const config = EthereumOutpostBootstrapper.outpostDeployConfig(
      rpcUrl,
      deployerPrivateKey,
      deploymentsPath,
      panicAccount,
      roster
    )
    expect(config.initialOperatorGroups.flat()).not.toContain(deployer.address)
    expect(config.initialOperatorGroups.flat()).not.toContain(panicAccount)
  })

  it("preserves principal above the safe integer range across JSON deployment config", () => {
    const principal = 9_007_199_254_740_993n,
      config = EthereumOutpostBootstrapper.outpostDeployConfig(
        rpcUrl,
        deployerPrivateKey,
        deploymentsPath,
        panicAccount,
        roster,
        principal
      )
    expect(JSON.parse(JSON.stringify(config)).mockSyndicatedPrincipal).toBe(
      "9007199254740993"
    )
  })

  it("writes the liqETH config with the panic account every DeployScript grants", () => {
    expect(
      JSON.parse(
        JSON.stringify(
          EthereumOutpostBootstrapper.liqEthDeployConfig(
            rpcUrl,
            deployerPrivateKey,
            deploymentsPath,
            panicAccount
          )
        )
      )
    ).toEqual({
      url: rpcUrl,
      key: deployerPrivateKey,
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
