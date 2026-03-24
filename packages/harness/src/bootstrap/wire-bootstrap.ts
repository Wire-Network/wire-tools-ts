import path from "path"
import fs from "fs"
import { Clio } from "../clients/clio.js"
import { log } from "../logger.js"
import { sleep, waitForEndpoint, retry } from "../util.js"

/**
 * WIRE chain bootstrap sequence.
 *
 * Replicates the sequence from cluster_manager.py:
 *   1. Create wallet, import sysio keys
 *   2. Deploy sysio.bios → activate protocol features
 *   3. Create system accounts
 *   4. Deploy sysio.system, sysio.token, sysio.msig
 *   5. Deploy OPP contracts (sysio.epoch, sysio.msgch, sysio.uwrit, sysio.chalg)
 *   6. Configure OPP (epoch config, outpost registration)
 */

export interface WireBootstrapConfig {
  /** Path to wire-sysio build directory */
  buildDir: string
  /** nodeop HTTP URL */
  httpUrl: string
  /** Path to clio binary */
  clioBinary: string
  /** kiod wallet URL */
  walletUrl?: string
  /** sysio private key (default: development key) */
  sysioPrivateKey?: string
  /** sysio public key (default: development key) */
  sysioPublicKey?: string
}

// Default development keypair (matches genesis)
const DEV_PRIVATE_KEY = "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3"
const DEV_PUBLIC_KEY = "SYS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"

// System accounts that need to be created
const SYSTEM_ACCOUNTS = [
  "sysio.bpay",
  "sysio.msig",
  "sysio.names",
  "sysio.ram",
  "sysio.ramfee",
  "sysio.saving",
  "sysio.stake",
  "sysio.token",
  "sysio.vpay",
  "sysio.wrap",
  "sysio.roa",
  "sysio.authex",
  // OPP contracts
  "sysio.epoch",
  "sysio.msgch",
  "sysio.uwrit",
  "sysio.chalg",
]

export class WireBootstrap {
  private clio: Clio
  private config: Required<WireBootstrapConfig>
  private walletPassword?: string

  constructor(config: WireBootstrapConfig) {
    this.config = {
      ...config,
      sysioPrivateKey: config.sysioPrivateKey || DEV_PRIVATE_KEY,
      sysioPublicKey: config.sysioPublicKey || DEV_PUBLIC_KEY,
      walletUrl: config.walletUrl || "",
    }
    this.clio = new Clio({
      binary: this.config.clioBinary,
      url: this.config.httpUrl,
      walletUrl: this.config.walletUrl || undefined,
    })
  }

  /** Contract directory within the build tree */
  private contractDir(name: string): string {
    // Check build dir first, then source contracts dir
    const buildContracts = path.join(this.config.buildDir, "contracts", name)
    if (fs.existsSync(path.join(buildContracts, `${name}.wasm`))) {
      return buildContracts
    }
    // Fall back to source contracts (pre-built wasm/abi)
    const srcContracts = path.resolve(this.config.buildDir, "..", "contracts", name)
    if (fs.existsSync(path.join(srcContracts, `${name}.wasm`))) {
      return srcContracts
    }
    throw new Error(`Contract ${name} not found in build or source dir`)
  }

  /** Run the full bootstrap sequence */
  async bootstrap(): Promise<void> {
    log.info("=== WIRE Chain Bootstrap ===")

    await this.waitForChain()
    await this.setupWallet()
    await this.deployBios()
    await this.activateProtocolFeatures()
    await this.createSystemAccounts()
    await this.deploySystemContracts()
    await this.deployOPPContracts()
    await this.configureOPP()

    log.info("=== WIRE Chain Bootstrap Complete ===")
  }

  private async waitForChain(): Promise<void> {
    log.info("Waiting for nodeop to be ready...")
    await waitForEndpoint(`${this.config.httpUrl}/v1/chain/get_info`, {
      label: "nodeop",
      timeoutMs: 30_000,
    })
  }

  private async setupWallet(): Promise<void> {
    log.info("Creating wallet and importing keys...")
    this.walletPassword = await this.clio.walletCreate("default")
    await this.clio.walletImportKey("default", this.config.sysioPrivateKey)
    log.info("Wallet created and sysio key imported")
  }

  private async deployBios(): Promise<void> {
    log.info("Deploying sysio.bios contract...")
    const dir = this.contractDir("sysio.bios")
    await retry(
      () => this.clio.setContract("sysio", dir, "sysio.bios.wasm", "sysio.bios.abi"),
      { label: "deploy sysio.bios", maxAttempts: 3, delayMs: 2000 }
    )
    log.info("sysio.bios deployed")
  }

  private async activateProtocolFeatures(): Promise<void> {
    log.info("Activating protocol features...")

    // Activate PREACTIVATE_FEATURE first (required for all others)
    // Then activate all builtin features via the /v1/producer/schedule_protocol_feature_activations endpoint
    try {
      const resp = await fetch(`${this.config.httpUrl}/v1/producer/get_supported_protocol_features`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const features = await resp.json() as any[]

      // Activate each feature
      for (const feature of features) {
        const digest = feature.feature_digest
        if (!digest) continue
        try {
          await this.clio.activateFeature(digest)
          log.debug(`Activated feature: ${feature.specification?.[0]?.value || digest}`)
        } catch (err: any) {
          // Some features may already be active or have dependencies
          if (!err.message?.includes("already activated")) {
            log.debug(`Feature activation skipped: ${digest} — ${err.message}`)
          }
        }
        await sleep(500)
      }
    } catch (err: any) {
      log.warn(`Protocol feature activation via API failed, trying individual activation: ${err.message}`)
    }

    log.info("Protocol features activated")
  }

  private async createSystemAccounts(): Promise<void> {
    log.info("Creating system accounts...")
    for (const account of SYSTEM_ACCOUNTS) {
      try {
        await this.clio.createSystemAccount(account, this.config.sysioPublicKey)
        log.debug(`Created account: ${account}`)
      } catch (err: any) {
        if (err.message?.includes("already exists") || err.stderr?.includes("already exists")) {
          log.debug(`Account ${account} already exists`)
        } else {
          throw err
        }
      }
    }
    log.info(`Created ${SYSTEM_ACCOUNTS.length} system accounts`)
  }

  private async deploySystemContracts(): Promise<void> {
    // Deploy sysio.system
    log.info("Deploying sysio.system...")
    const systemDir = this.contractDir("sysio.system")
    await retry(
      () => this.clio.setContract("sysio", systemDir, "sysio.system.wasm", "sysio.system.abi"),
      { label: "deploy sysio.system", maxAttempts: 3, delayMs: 2000 }
    )

    // Deploy sysio.token
    log.info("Deploying sysio.token...")
    const tokenDir = this.contractDir("sysio.token")
    await retry(
      () => this.clio.setContract("sysio.token", tokenDir, "sysio.token.wasm", "sysio.token.abi"),
      { label: "deploy sysio.token", maxAttempts: 3, delayMs: 2000 }
    )

    // Deploy sysio.msig
    log.info("Deploying sysio.msig...")
    const msigDir = this.contractDir("sysio.msig")
    await retry(
      () => this.clio.setContract("sysio.msig", msigDir, "sysio.msig.wasm", "sysio.msig.abi"),
      { label: "deploy sysio.msig", maxAttempts: 3, delayMs: 2000 }
    )

    // Set privileged accounts
    await this.clio.setPriv("sysio.msig")

    log.info("System contracts deployed")
  }

  private async deployOPPContracts(): Promise<void> {
    const oppContracts = [
      { account: "sysio.epoch", name: "sysio.epoch" },
      { account: "sysio.msgch", name: "sysio.msgch" },
      { account: "sysio.uwrit", name: "sysio.uwrit" },
      { account: "sysio.chalg", name: "sysio.chalg" },
    ]

    for (const { account, name } of oppContracts) {
      log.info(`Deploying ${name}...`)
      try {
        const dir = this.contractDir(name)
        await retry(
          () => this.clio.setContract(account, dir, `${name}.wasm`, `${name}.abi`),
          { label: `deploy ${name}`, maxAttempts: 3, delayMs: 2000 }
        )
        // Set privileged
        await this.clio.setPriv(account)
        log.info(`${name} deployed and set privileged`)
      } catch (err: any) {
        log.warn(`Failed to deploy ${name} (may not be built yet): ${err.message}`)
      }
    }
  }

  private async configureOPP(): Promise<void> {
    log.info("Configuring OPP epoch system...")

    // sysio.epoch::setconfig
    try {
      await this.clio.pushAction("sysio.epoch", "setconfig",
        JSON.stringify({
          epoch_duration_sec: 360,
          operators_per_epoch: 7,
          total_operators: 21,
          groups: 3,
          warmup_epochs: 1,
          cooldown_epochs: 1,
        }),
        "sysio.epoch@active"
      )
      log.info("Epoch config set (360s epochs, 7 per epoch, 3 groups)")
    } catch (err: any) {
      log.warn(`Failed to configure epoch: ${err.message}`)
    }

    // Register outposts: ETHEREUM (chain_kind=2, chain_id=31337) and SOLANA (chain_kind=3, chain_id=1)
    try {
      await this.clio.pushAction("sysio.epoch", "regoutpost",
        JSON.stringify({ chain_kind: 2, chain_id: 31337 }),
        "sysio.epoch@active"
      )
      log.info("Registered ETH outpost (chain_kind=2, chain_id=31337)")
    } catch (err: any) {
      log.warn(`Failed to register ETH outpost: ${err.message}`)
    }

    try {
      await this.clio.pushAction("sysio.epoch", "regoutpost",
        JSON.stringify({ chain_kind: 3, chain_id: 1 }),
        "sysio.epoch@active"
      )
      log.info("Registered SOL outpost (chain_kind=3, chain_id=1)")
    } catch (err: any) {
      log.warn(`Failed to register SOL outpost: ${err.message}`)
    }

    // sysio.uwrit::setconfig
    try {
      await this.clio.pushAction("sysio.uwrit", "setconfig",
        JSON.stringify({
          fee_bps: 10,
          confirm_lock_sec: 86400,
          uw_fee_share_pct: 50,
          other_uw_share_pct: 25,
          batch_op_share_pct: 25,
        }),
        "sysio.uwrit@active"
      )
      log.info("Underwriting config set (10bps fee, 24hr lock)")
    } catch (err: any) {
      log.warn(`Failed to configure underwriting: ${err.message}`)
    }

    log.info("OPP configuration complete")
  }
}
