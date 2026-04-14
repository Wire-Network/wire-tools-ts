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

const execFileAsync = promisify(execFile)

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
    const mnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic),
      accounts: ETHAccount[] = []

    for (let i = 0; i < count; i++) {
      const path = `${ETHBootstrapper.DerivationPath}${i}`,
        wallet = ethers.HDNodeWallet.fromMnemonic(mnemonic, path)

      accounts.push({
        address: wallet.address,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        usedInBootstrap: false,
        usedFor: ""
      })
    }

    return accounts
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
    for (const f of ["liqeth-addrs.json", "outpost-addrs.json"]) {
      const p = Path.join(localDir, f)
      if (Fs.existsSync(p)) Fs.unlinkSync(p)
    }

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
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          // Ensure hardhat uses the right network config
          HARDHAT_NETWORK: "localhost"
        }
      }
    )

    if (stderr) {
      // Hardhat often writes warnings to stderr (compiler warnings, etc.)
      log.debug(`[ETH] hardhat stderr:\n${stderr.slice(0, 1000)}`)
    }

    log.info(`[ETH] Deploy output:\n${stdout.slice(-500)}`)

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

export default ETHBootstrapper
