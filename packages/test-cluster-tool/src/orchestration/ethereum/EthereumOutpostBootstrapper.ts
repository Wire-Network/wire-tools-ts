import { execFile } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { promisify } from "node:util"
import { ethers } from "ethers"
import { defaults, range } from "lodash"
import Assert from "node:assert"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { LongFileLockOptions, mkdirs, withFileLock } from "../../utils/fsUtils.js"

const log = getLogger(__filename)
const execFileAsync = promisify(execFile)

/** One deterministic anvil account, annotated with its bootstrap usage. */
export interface EthereumAccount {
  address: string
  privateKey: string
  publicKey: string
  usedInBootstrap: boolean
  usedFor: string
}

/** Caller options for {@link EthereumOutpostBootstrapper}. */
export interface EthereumOutpostBootstrapperOptions {
  /** Path to the `wire-ethereum` repo root. */
  ethereumPath: string
  /** Cluster data path for the annotated accounts file. */
  anvilDataPath: string
  /** RPC URL of the already-running run anvil to deploy against. */
  rpcUrl: string
  /**
   * THIS cluster's deploy-artifact dir (`ClusterConfig.ethereumDeploymentsPath`)
   * — deploy configs + address files land here, and `deployLocal.ts` is pointed
   * at it via `WIRE_ETH_DEPLOYMENTS_PATH`. Per-cluster so parallel flows never
   * clobber each other's deploy state (2026-07-02 pair-1 incident: two deploys
   * sharing `<wire-ethereum>/.local/deployments/` wiped each other mid-run).
   */
  deploymentsPath: string
  /**
   * Number of deterministic accounts to generate — MUST match the run anvil's
   * `--accounts` (default: {@link AnvilProcess.AccountCount}) so every generated
   * account maps to a pre-funded anvil account.
   */
  accountCount?: number
}

/** Resolved {@link EthereumOutpostBootstrapper} config. */
export interface EthereumOutpostBootstrapperConfig
  extends Required<EthereumOutpostBootstrapperOptions> {}

/**
 * Bootstrap the Ethereum (anvil) outpost for the test cluster: generate
 * deterministic accounts from anvil's default mnemonic, deploy the
 * `wire-ethereum` contracts via Hardhat AGAINST the already-running run anvil,
 * seed the `ReserveManager` with physical custody, and write an annotated
 * accounts file.
 *
 * The run anvil is started separately (`Steps.processes.anvil.start`) and owned
 * by the process manager for the whole cluster lifecycle — this bootstrapper
 * never spawns its own anvil; it only deploys against the one it is handed.
 *
 * Test-cluster custody priming (`seedReserveManager`) lives HERE in the
 * harness, never in `wire-ethereum`'s `deployLocal.ts` — it runs after the
 * deploy returns and owns its own nonce counter.
 */
export class EthereumOutpostBootstrapper {
  private readonly config: EthereumOutpostBootstrapperConfig
  private accounts: EthereumAccount[] = []

  constructor(options: EthereumOutpostBootstrapperOptions) {
    Assert.ok(options.ethereumPath, "EthereumOutpostBootstrapper: ethereumPath is required")
    Assert.ok(options.anvilDataPath, "EthereumOutpostBootstrapper: anvilDataPath is required")
    Assert.ok(options.rpcUrl, "EthereumOutpostBootstrapper: rpcUrl is required")
    Assert.ok(
      options.deploymentsPath,
      "EthereumOutpostBootstrapper: deploymentsPath is required"
    )
    this.config = defaults(
      { ...options },
      EthereumOutpostBootstrapper.createDefaultOptions()
    ) as EthereumOutpostBootstrapperConfig
  }

  /**
   * Run the full Ethereum-outpost bootstrap: generate accounts → deploy
   * contracts against the running anvil → seed the ReserveManager → write the
   * annotated accounts file. The anvil is neither started nor stopped here —
   * it is the process-manager-owned run anvil for the whole cluster lifecycle.
   */
  async bootstrap(): Promise<EthereumAccount[]> {
    const { ethereumPath, anvilDataPath, rpcUrl, accountCount } = this.config

    log.info(`[ethereum] generating ${accountCount} accounts, deploying against ${rpcUrl}`)
    this.accounts = EthereumOutpostBootstrapper.generateAccounts(accountCount)

    await this.deployContracts(ethereumPath, rpcUrl)
    // Seed ReserveManager AFTER deploy so `outpost-addrs.json` reflects the
    // final addresses; the depot's logical `sysio.reserv` view and the
    // outpost's physical custody are independent ledgers (a non-native dst
    // SwapRemit can only draw against physically-funded custody).
    await this.seedReserveManager(rpcUrl, ethereumPath)

    const accountsFile = Path.join(mkdirs(anvilDataPath), EthereumOutpostBootstrapper.AccountsFile)
    Fs.writeFileSync(accountsFile, JSON.stringify(this.accounts, null, 2))
    log.info(`[ethereum] wrote ${this.accounts.length} accounts to ${accountsFile}`)

    return this.accounts
  }

  /** Mark an account as used during bootstrap (for the annotated accounts file). */
  private markAccountUsed(index: number, usedFor: string): void {
    const account = this.accounts[index]
    if (account != null) {
      account.usedInBootstrap = true
      account.usedFor = usedFor
    }
  }

  /**
   * Deploy the `wire-ethereum` contracts by invoking Hardhat's `deployLocal.ts`.
   * Writes deploy configs (pointing at the running anvil, deployer = account 0)
   * into THIS cluster's `deploymentsPath` — `deployLocal.ts` reads/writes the
   * same dir via `WIRE_ETH_DEPLOYMENTS_PATH` — clearing any stale address files
   * first so a previous anvil's addresses can't be picked up by mistake. The
   * hardhat invocation itself is serialized host-wide: parallel runs share the
   * repo's compile cache/artifacts, and concurrent compiles corrupt them.
   */
  private async deployContracts(ethereumPath: string, rpcUrl: string): Promise<void> {
    log.info(`[ethereum] deploying contracts from ${ethereumPath}`)
    const deployerPrivateKey =
      this.accounts[EthereumOutpostBootstrapper.DeployerAccountIndex].privateKey
    this.markAccountUsed(
      EthereumOutpostBootstrapper.DeployerAccountIndex,
      "Contract deployer (LiqEth + Outpost)"
    )

    const localDir = this.config.deploymentsPath
    mkdirs(localDir)
    EthereumOutpostBootstrapper.StaleDeployArtifactFiles.forEach(name => {
      const file = Path.join(localDir, name)
      if (Fs.existsSync(file)) Fs.unlinkSync(file)
    })

    const liqEthConfig = {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(localDir, "liqeth-addrs.json"),
      gasLimitFile: Path.join(localDir, "liqeth-gas-limits.json"),
      entryQueue: 47,
      dailyRateBPS: 283,
      rewardCooldown: 100,
      withdrawalDelay: 50
    }
    const outpostConfig = {
      url: rpcUrl,
      key: deployerPrivateKey,
      addressFile: Path.join(localDir, "outpost-addrs.json"),
      gasLimitFile: Path.join(localDir, "outpost-gas-limits.json"),
      useMockAggregator: true
    }
    Fs.writeFileSync(Path.join(localDir, "liqeth.json"), JSON.stringify(liqEthConfig, null, 2))
    Fs.writeFileSync(Path.join(localDir, "outpost.json"), JSON.stringify(outpostConfig, null, 2))

    log.info("[ethereum] running deployLocal.ts via hardhat...")
    StepExtraRecorder.record({
      client: "process",
      kind: "exec",
      command: ["npx", "hardhat", "run", "src/scripts/deployLocal.ts", "--network", "localhost"],
      cwd: ethereumPath
    })
    // withFileLock: hardhat compiles into the SHARED repo cache/artifacts on
    // demand — two concurrent compiles corrupt them. The per-run state (configs
    // + address files) is already isolated via deploymentsPath.
    const { stdout, stderr } = await withFileLock(
      EthereumOutpostBootstrapper.HardhatDeployLockPath,
      () =>
        execFileAsync(
          "npx",
          ["hardhat", "run", "src/scripts/deployLocal.ts", "--network", "localhost"],
          {
            cwd: ethereumPath,
            timeout: EthereumOutpostBootstrapper.HardhatDeployTimeoutMs,
            maxBuffer: EthereumOutpostBootstrapper.HardhatDeployBufferBytes,
            env: {
              ...process.env,
              HARDHAT_NETWORK: "localhost",
              WIRE_ETH_DEPLOYMENTS_PATH: localDir
            }
          }
        ),
      LongFileLockOptions
    )
    if (stderr)
      log.debug(
        `[ethereum] hardhat stderr:\n${stderr.slice(0, EthereumOutpostBootstrapper.HardhatStderrTailChars)}`
      )
    log.info(
      `[ethereum] deploy output:\n${stdout.slice(-EthereumOutpostBootstrapper.HardhatStdoutTailChars)}`
    )

    EthereumOutpostBootstrapper.StaleDeployArtifactFiles.forEach(name => {
      const file = Path.join(localDir, name)
      if (Fs.existsSync(file)) {
        const contents = Fs.readFileSync(file, "utf-8")
        log.info(`[ethereum] ${name}: ${contents}`)
        // The deploy's OUTPUT — the deployed contract addresses — is the
        // step's payload; land each artifact file in the step extra.
        StepExtraRecorder.record({
          client: "harness",
          kind: "artifact",
          file: name,
          contents: JSON.parse(contents) as Record<string, unknown>
        })
      }
    })
    log.info("[ethereum] contract deployment complete")
  }

  /**
   * Send native ETH + mock ERC-20 (USDC / USDT / LIQETH) from the deployer
   * wallet to `ReserveManager` so its physical custody matches the depot's
   * `sysio.reserv::regreserve` logical view. Uses a single owner-managed nonce
   * counter (seeded once from `getNonce("pending")`, incremented per tx) to
   * avoid the back-to-back-tx nonce race.
   */
  private async seedReserveManager(rpcUrl: string, ethereumPath: string): Promise<void> {
    const outpostAddressesFile = Path.join(
      this.config.deploymentsPath,
      "outpost-addrs.json"
    )
    if (!Fs.existsSync(outpostAddressesFile)) {
      log.warn("[ethereum] seedReserveManager: outpost-addrs.json missing, skipping")
      return
    }
    const addresses = JSON.parse(Fs.readFileSync(outpostAddressesFile, "utf-8"))
    const reserveManagerAddress: string | null = addresses.ReserveManager ?? null
    const mockUsdcAddress: string | null = addresses.MockUsdc ?? null
    const mockUsdtAddress: string | null = addresses.MockUsdt ?? null
    if (reserveManagerAddress == null) {
      log.warn("[ethereum] seedReserveManager: ReserveManager address missing, skipping")
      return
    }

    // Bind the deployer (anvil HD index 0) — the same identity deployLocal.ts
    // used as `owner`, so its minted MockUSDC/USDT balances are available here.
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const deployer = new ethers.Wallet(
      this.accounts[EthereumOutpostBootstrapper.DeployerAccountIndex].privateKey,
      provider
    )
    let nonce = await deployer.getNonce("pending")
    log.info(`[ethereum] seedReserveManager start (deployer=${deployer.address}, nonce=${nonce})`)

    const nativeSeed = ethers.parseEther(EthereumOutpostBootstrapper.NativeSeedEther)
    const stableSeed = ethers.parseUnits(
      EthereumOutpostBootstrapper.StableSeedUnits,
      EthereumOutpostBootstrapper.StableDecimals
    )

    log.info(`[ethereum] seed ${ethers.formatEther(nativeSeed)} ETH (nonce ${nonce})`)
    const ethTx = await deployer.sendTransaction({
      to: reserveManagerAddress,
      value: nativeSeed,
      nonce: nonce++
    })
    await ethTx.wait()

    const transferStable = async (tokenAddress: string, label: string): Promise<void> => {
      log.info(`[ethereum] seed ${ethers.formatUnits(stableSeed, 6)} ${label} (nonce ${nonce})`)
      const token = new ethers.Contract(tokenAddress, EthereumOutpostBootstrapper.Erc20Abi, deployer)
      const tx = await token.transfer(reserveManagerAddress, stableSeed, { nonce: nonce++ })
      await tx.wait()
    }
    if (mockUsdcAddress != null) await transferStable(mockUsdcAddress, "USDC")
    if (mockUsdtAddress != null) await transferStable(mockUsdtAddress, "USDT")

    // LIQETH only if the LiqEth deploy went through (toggled off for outpost-only runs).
    const liqEthAddress: string | null = addresses.LiqEth ?? null
    if (liqEthAddress != null) {
      const liqEthSeed = ethers.parseEther(EthereumOutpostBootstrapper.NativeSeedEther)
      const liqEth = new ethers.Contract(liqEthAddress, EthereumOutpostBootstrapper.Erc20Abi, deployer)
      const ownerLiqEthBalance: bigint = await liqEth.balanceOf(deployer.address)
      if (ownerLiqEthBalance >= liqEthSeed) {
        log.info(`[ethereum] seed ${ethers.formatEther(liqEthSeed)} LIQETH (nonce ${nonce})`)
        const liqEthTx = await liqEth.transfer(reserveManagerAddress, liqEthSeed, { nonce: nonce++ })
        await liqEthTx.wait()
      } else {
        log.info(
          `[ethereum] skip LIQETH seed (deployer balance ${ethers.formatEther(ownerLiqEthBalance)} < ${ethers.formatEther(liqEthSeed)})`
        )
      }
    }
    log.info("[ethereum] seedReserveManager complete")
  }
}

export namespace EthereumOutpostBootstrapper {
  /** Annotated accounts filename written under the anvil data path. */
  export const AccountsFile = "accounts.json"
  /** Anvil's default deterministic mnemonic. */
  export const AnvilMnemonic = "test test test test test test test test test test test junk"
  /** BIP-44 derivation path prefix anvil uses for its accounts. */
  export const DerivationPath = "m/44'/60'/0'/0/"
  /** HD index of the deployer account. */
  export const DeployerAccountIndex = 0
  /** Deploy-artifact files cleared before every deploy (stale-address guard). */
  export const StaleDeployArtifactFiles = ["liqeth-addrs.json", "outpost-addrs.json"] as const
  /**
   * Host-global lock serializing the hardhat deploy subprocess across every
   * wire process: parallel deploys share `<wire-ethereum>`'s compile
   * cache/artifacts, and concurrent hardhat compiles corrupt them. Per-run
   * deploy STATE is isolated separately (see `deploymentsPath`).
   */
  export const HardhatDeployLockPath = Path.join(
    Os.tmpdir(),
    "wire-ethereum-hardhat-deploy.lock"
  )
  /** Hardhat deploy subprocess timeout (ms). */
  export const HardhatDeployTimeoutMs = 120_000
  /** Hardhat deploy subprocess stdout/stderr buffer cap (bytes). */
  export const HardhatDeployBufferBytes = 10 * 1_024 * 1_024
  /** Chars of Hardhat stderr logged after a run. */
  export const HardhatStderrTailChars = 1_000
  /** Chars of Hardhat stdout logged after a run. */
  export const HardhatStdoutTailChars = 500
  /** Native ETH amount seeded into ReserveManager. */
  export const NativeSeedEther = "100"
  /** Stable-coin amount seeded into ReserveManager (whole units). */
  export const StableSeedUnits = "100"
  /** Decimals for the mock stable-coins (USDC / USDT). */
  export const StableDecimals = 6
  /** Minimal ERC-20 ABI for the custody-seeding transfers. */
  export const Erc20Abi = [
    "function transfer(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)"
  ] as const

  /** Resolve the default (overridable) options. `accountCount` tracks the run
   *  anvil's `--accounts` so every generated account is pre-funded. */
  export function createDefaultOptions(): Partial<EthereumOutpostBootstrapperOptions> {
    return {
      accountCount: AnvilProcess.AccountCount
    }
  }

  /**
   * Generate `count` deterministic accounts from anvil's default mnemonic —
   * they match exactly what anvil generates internally.
   */
  export function generateAccounts(count: number): EthereumAccount[] {
    const mnemonic = ethers.Mnemonic.fromPhrase(AnvilMnemonic)
    return range(count).map(index => {
      const wallet = ethers.HDNodeWallet.fromMnemonic(mnemonic, `${DerivationPath}${index}`)
      return {
        address: wallet.address,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        usedInBootstrap: false,
        usedFor: ""
      }
    })
  }
}
