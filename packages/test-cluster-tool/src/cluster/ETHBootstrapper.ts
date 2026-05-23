/**
 * Ethereum (Anvil) bootstrapper for wire-test-cluster.
 *
 * Responsible for:
 *   1. Starting anvil with N accounts and a specified ETH balance
 *   2. Capturing generated account addresses + private keys
 *   3. Running wire-ethereum's deployLocal.ts against the running anvil
 *   4. Writing accounts.json with usage annotations
 */

import Fs from "fs"
import Path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { log } from "../logger.js"
import { AnvilManager, type AnvilOptions } from "../processes/AnvilManager.js"
import { mkdirs } from "../util.js"
import { ethers } from "ethers"
import { range } from "lodash"

const execFileAsync = promisify(execFile)

/**
 * Filenames written by the wire-ethereum Hardhat deploy scripts. Cleared at
 * the start of every bootstrap so stale addresses from a previous anvil
 * instance can't be picked up by mistake.
 */
const StaleDeployArtifactFiles = [
  "liqeth-addrs.json",
  "outpost-addrs.json"
] as const

/** Hardhat deploy subprocess timeout. Raise if your hardware is genuinely slower. */
const HardhatDeployTimeoutMs = 120_000
/** Subprocess stdout/stderr buffer cap. */
const HardhatDeployBufferBytes = 10 * 1_024 * 1_024
/** Length of the stderr tail logged after a Hardhat run. */
const HardhatStderrTailChars = 1_000
/** Length of the stdout tail logged after a Hardhat run. */
const HardhatStdoutTailChars = 500

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ETHAccount {
  address: string
  privateKey: string
  publicKey: string
  usedInBootstrap: boolean
  usedFor: string
}

export interface ETHBootstrapOptions {
  /** Path to wire-ethereum repo root */
  ethereumPath: string
  /** Cluster data path for anvil state/accounts */
  anvilDataPath: string
  /** Anvil RPC port (default: 8545) */
  anvilPort?: number
  /** Anvil chain ID (default: 31337) */
  chainId?: number
  /** Number of accounts to generate (default: 50) */
  accountCount?: number
  /** ETH balance per account (default: 100000) */
  balancePerAccount?: number
}

// ---------------------------------------------------------------------------
// ETHBootstrapper
// ---------------------------------------------------------------------------

/**
 * Bootstrap an Ethereum (anvil) environment for the test cluster.
 *
 * Generates deterministic accounts from anvil's default mnemonic,
 * deploys wire-ethereum contracts, and writes an annotated accounts file.
 */
export class ETHBootstrapper {
  private accounts: ETHAccount[] = []
  private deployerAccountIndex = 0

  constructor(private readonly opts: ETHBootstrapOptions) {}

  /**
   * Run the full ETH bootstrap sequence:
   * 1. Generate account list from mnemonic
   * 2. Start anvil
   * 3. Deploy contracts via hardhat
   * 4. Write accounts.json
   */
  async bootstrap(): Promise<ETHAccount[]> {
    const {
      ethereumPath,
      anvilDataPath,
      anvilPort = ETHBootstrapper.DefaultPort,
      chainId = ETHBootstrapper.DefaultChainId,
      accountCount = ETHBootstrapper.DefaultAccountCount,
      balancePerAccount = ETHBootstrapper.DefaultBalancePerAccount
    } = this.opts

    // ── 1. Generate accounts from mnemonic ──
    log.info(
      `[ETH] Generating ${accountCount} accounts (${balancePerAccount} ETH each)`
    )
    this.accounts = this.generateAccounts(accountCount)

    // ── 2. Start anvil ──
    const statePath = mkdirs(
        Path.join(anvilDataPath, ETHBootstrapper.AnvilStateSubpath)
      ),
      stateFile = Path.join(statePath, "anvil.json")

    const anvil = await AnvilManager.create({
      port: anvilPort,
      chainId,
      stateFile,
      extraArgs: [
        "--accounts",
        String(accountCount),
        "--balance",
        String(balancePerAccount),
        "--code-size-limit",
        "99999"
      ]
    })
    await anvil.start()

    const rpcUrl = anvil.rpcUrl
    log.info(`[ETH] Anvil running at ${rpcUrl}`)

    try {
      // ── 3. Deploy contracts ──
      await this.deployContracts(ethereumPath, rpcUrl)

      // ── 3b. Seed ReserveManager + Mock-ERC-20 reserves with custody
      //        balances. The depot's `sysio.reserv::regreserve` records
      //        10_000_000_000 depot-9-dec units logically per reserve,
      //        but the outpost-side custody (contract balance / ERC-20
      //        balanceOf) is independent and must be physically funded
      //        for a SwapRemit (or RESERVE_REMIT) on a non-native dst
      //        to have anything to draw against.
      //
      //        Flows whose first swap is ETH→X fund the reserve as a
      //        side-effect of the user-initiated requestSwap; flows
      //        where every ETH-side test sources from ERC-20 (e.g.
      //        flow-swap-non-native-tokens, where test 6's USDCSOL→ETH
      //        direction precedes any ETH→X) need the seed because no
      //        ETH ever flows into the reserve before the first
      //        X→ETH SwapRemit lands.
      await this.seedReserveManager(rpcUrl, ethereumPath)

      // ── 4. Write accounts.json ──
      const accountsFile = Path.join(
        anvilDataPath,
        ETHBootstrapper.AccountsFile
      )
      Fs.writeFileSync(accountsFile, JSON.stringify(this.accounts, null, 2))
      log.info(
        `[ETH] Wrote ${this.accounts.length} accounts to ${accountsFile}`
      )
    } finally {
      // Stop anvil (state is dumped to stateFile on exit)
      await anvil.stop()
    }

    return this.accounts
  }

  /**
   * Generate deterministic accounts from anvil's default mnemonic.
   * These match exactly what anvil generates internally.
   */
  private generateAccounts(count: number): ETHAccount[] {
    const mnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic)
    return range(count).map(i => {
      const wallet = ethers.HDNodeWallet.fromMnemonic(
        mnemonic,
        `${ETHBootstrapper.DerivationPath}${i}`
      )
      return {
        address: wallet.address,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        usedInBootstrap: false,
        usedFor: ""
      }
    })
  }

  /**
   * Mark an account as used during bootstrap.
   */
  private markAccountUsed(index: number, usedFor: string): void {
    if (index < this.accounts.length) {
      this.accounts[index].usedInBootstrap = true
      this.accounts[index].usedFor = usedFor
    }
  }

  /**
   * Deploy wire-ethereum contracts by invoking hardhat's deployLocal.ts.
   *
   * The deploy script reads config from .local/deployments/ — we write
   * temporary configs pointing at the running anvil instance and using
   * the first generated account as the deployer.
   */
  private async deployContracts(
    ethereumPath: string,
    rpcUrl: string
  ): Promise<void> {
    log.info(`[ETH] Deploying contracts from ${ethereumPath}`)

    // Use account[0] as the deployer
    const deployerKey = this.accounts[0].privateKey
    this.markAccountUsed(0, "Contract deployer (LiqEth + Outpost)")

    // Write temporary deploy configs pointing at our anvil
    const localDir = Path.join(ethereumPath, ".local", "deployments")
    mkdirs(localDir)

    // Clear stale address files (fresh deploy)
    StaleDeployArtifactFiles.forEach(name => {
      const p = Path.join(localDir, name)
      if (Fs.existsSync(p)) Fs.unlinkSync(p)
    })

    const liqethConfig = {
      url: rpcUrl,
      key: deployerKey,
      addressFile: Path.join(localDir, "liqeth-addrs.json"),
      gasLimitFile: Path.join(localDir, "liqeth-gas-limits.json"),
      entryQueue: 47,
      dailyRateBPS: 283,
      rewardCooldown: 100,
      withdrawalDelay: 50
    }

    const outpostConfig = {
      url: rpcUrl,
      key: deployerKey,
      addressFile: Path.join(localDir, "outpost-addrs.json"),
      gasLimitFile: Path.join(localDir, "outpost-gas-limits.json"),
      useMockAggregator: true
    }

    Fs.writeFileSync(
      Path.join(localDir, "liqeth.json"),
      JSON.stringify(liqethConfig, null, 2)
    )
    Fs.writeFileSync(
      Path.join(localDir, "outpost.json"),
      JSON.stringify(outpostConfig, null, 2)
    )

    log.info("[ETH] Running deployLocal.ts via hardhat...")

    const npxPath = process.execPath.replace(/node$/, "npx")
    const { stdout, stderr } = await execFileAsync(
      "npx",
      [
        "hardhat",
        "run",
        "src/scripts/deployLocal.ts",
        "--network",
        "localhost"
      ],
      {
        cwd: ethereumPath,
        timeout: HardhatDeployTimeoutMs,
        maxBuffer: HardhatDeployBufferBytes,
        env: {
          ...process.env,
          // Ensure hardhat uses the right network config
          HARDHAT_NETWORK: "localhost"
        }
      }
    )

    if (stderr) {
      // Hardhat often writes warnings to stderr (compiler warnings, etc.)
      log.debug(`[ETH] hardhat stderr:\n${stderr.slice(0, HardhatStderrTailChars)}`)
    }

    log.info(`[ETH] Deploy output:\n${stdout.slice(-HardhatStdoutTailChars)}`)

    // Read deployed addresses and annotate accounts
    const liqethAddrsFile = Path.join(localDir, "liqeth-addrs.json")
    if (Fs.existsSync(liqethAddrsFile)) {
      const addrs = JSON.parse(Fs.readFileSync(liqethAddrsFile, "utf-8"))
      log.info("[ETH] LiqEth addresses:", JSON.stringify(addrs))
    }

    const outpostAddrsFile = Path.join(localDir, "outpost-addrs.json")
    if (Fs.existsSync(outpostAddrsFile)) {
      const addrs = JSON.parse(Fs.readFileSync(outpostAddrsFile, "utf-8"))
      log.info("[ETH] Outpost addresses:", JSON.stringify(addrs))
    }

    log.info("[ETH] Contract deployment complete")
  }

  /**
   * Send native ETH + mock ERC-20 (USDC/USDT/LIQETH) from the
   * deployer wallet to ReserveManager so it holds physical custody
   * matching the depot's `sysio.reserv::regreserve` logical view.
   *
   * Runs AFTER `deployContracts` returns, so anvil + every contract
   * is up and `outpost-addrs.json` reflects the final addresses. Uses
   * a single owner-managed nonce counter (seeded from `getNonce("pending")`
   * once, incremented per tx) to avoid the back-to-back-tx nonce race
   * that surfaced when these transfers were attempted inside
   * `deployLocal.ts` after the AccessManager `manager.execute` flow.
   */
  private async seedReserveManager(
    rpcUrl:       string,
    ethereumPath: string
  ): Promise<void> {
    const outpostAddrsFile = Path.join(
      ethereumPath, ".local", "deployments", "outpost-addrs.json"
    )
    if (!Fs.existsSync(outpostAddrsFile)) {
      log.warn("[ETH] seedReserveManager: outpost-addrs.json missing, skipping")
      return
    }
    const addrs = JSON.parse(Fs.readFileSync(outpostAddrsFile, "utf-8"))
    const reserveManagerAddr: string | undefined = addrs.ReserveManager
    const mockUsdcAddr:       string | undefined = addrs.MockUsdc
    const mockUsdtAddr:       string | undefined = addrs.MockUsdt
    if (!reserveManagerAddr) {
      log.warn("[ETH] seedReserveManager: ReserveManager addr missing, skipping")
      return
    }

    // Bind deployer (anvil HD-index 0) — same identity deployLocal.ts
    // used as `owner` so previously-minted MockUSDC/USDT balances are
    // available here for transfer.
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const deployer = new ethers.Wallet(this.accounts[0].privateKey, provider)
    let nonce = await deployer.getNonce("pending")
    log.info(`[ETH] seedReserveManager start (deployer=${deployer.address}, nonce=${nonce})`)

    const erc20Abi = [
      "function transfer(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)"
    ]
    const ethSeed   = ethers.parseEther("100")
    const stableSeed = ethers.parseUnits("100", 6)

    log.info(`[ETH] seed ${ethers.formatEther(ethSeed)} ETH (nonce ${nonce})`)
    const ethTx = await deployer.sendTransaction({
      to:    reserveManagerAddr,
      value: ethSeed,
      nonce: nonce++
    })
    await ethTx.wait()

    if (mockUsdcAddr) {
      log.info(`[ETH] seed ${ethers.formatUnits(stableSeed, 6)} USDC (nonce ${nonce})`)
      const usdc = new ethers.Contract(mockUsdcAddr, erc20Abi, deployer)
      const usdcTx = await usdc.transfer(reserveManagerAddr, stableSeed, { nonce: nonce++ })
      await usdcTx.wait()
    }
    if (mockUsdtAddr) {
      log.info(`[ETH] seed ${ethers.formatUnits(stableSeed, 6)} USDT (nonce ${nonce})`)
      const usdt = new ethers.Contract(mockUsdtAddr, erc20Abi, deployer)
      const usdtTx = await usdt.transfer(reserveManagerAddr, stableSeed, { nonce: nonce++ })
      await usdtTx.wait()
    }

    // LIQETH only if the LiqEth deploy went through (sometimes
    // toggled off for outpost-only test runs).
    const liqEthAddr: string | undefined = addrs.LiqEth
    if (liqEthAddr) {
      const liqEthSeed = ethers.parseEther("100")
      const liqEth = new ethers.Contract(liqEthAddr, erc20Abi, deployer)
      const ownerLiqBal: bigint = await liqEth.balanceOf(deployer.address)
      if (ownerLiqBal >= liqEthSeed) {
        log.info(`[ETH] seed ${ethers.formatEther(liqEthSeed)} LIQETH (nonce ${nonce})`)
        const liqTx = await liqEth.transfer(reserveManagerAddr, liqEthSeed, { nonce: nonce++ })
        await liqTx.wait()
      } else {
        log.info(`[ETH] skip LIQETH seed (deployer bal ${ethers.formatEther(ownerLiqBal)} < ${ethers.formatEther(liqEthSeed)})`)
      }
    }
    log.info("[ETH] seedReserveManager complete")
  }
}

export namespace ETHBootstrapper {
  export const DefaultAccountCount = 50
  export const DefaultBalancePerAccount = 100_000
  export const DefaultPort = AnvilManager.DefaultPort
  export const DefaultChainId = AnvilManager.DefaultChainId
  export const AccountsFile = "accounts.json"
  export const AnvilStateSubpath = "state"
  export const AnvilMnemonic =
    "test test test test test test test test test test test junk"
  export const DerivationPath = "m/44'/60'/0'/0/"
}
