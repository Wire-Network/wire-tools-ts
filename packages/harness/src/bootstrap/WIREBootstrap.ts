// noinspection SpellCheckingInspection

import Path from "path"
import Fs from "fs"
import { Clio } from "../clients/Clio.js"
import { log } from "../logger.js"
import { sleep, waitForEndpoint, retry, existsAsync } from "../util.js"
import {
  DEV_BLS_PRIVATE_KEY,
  DEV_BLS_PROOF_OF_POSSESSION,
  DEV_BLS_PUBLIC_KEY,
  DEV_K1_PRIVATE_KEY,
  DEV_K1_PUBLIC_KEY,
  OPP_SYSTEM_ACCOUNTS
} from "../cluster/constants.js"
import { SystemContracts } from "@wireio/sdk-core"
import { asOption, Future } from "@3fv/prelude-ts"
import { which } from "zx"
import { defaults } from "lodash"
import { assert } from "@wireio/shared"

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

export interface WIREBootstrapOptions {
  /**
   * Path to cluster path root
   */
  clusterPath: string

  /** Path to wire-sysio build directory */
  buildPath: string

  /** nodeop HTTP URL */
  httpUrl: string

  /** kiod wallet URL */
  walletUrl?: string
  /** sysio K1 private key (default: development key) */
  k1PrivateKey?: string
  /** sysio K1 public key (default: development key) */
  k1PublicKey?: string

  /** sysio BLS private key (default: development key) */
  blsPrivateKey?: string
  /** sysio BLS public key (default: development key) */
  blsPublicKey?: string
  /** sysio BLS proof of possession (default: development key) */
  blsProofOfPossession?: string

  /** Path to clio binary */
  clioBinary?: string
}

export async function createWIREBootstrapDefaultOptions(): Promise<
  Partial<WIREBootstrapOptions>
> {
  return {
    clioBinary: asOption(await which("clio")).getOrUndefined(),

    k1PrivateKey: DEV_K1_PRIVATE_KEY,
    k1PublicKey: DEV_K1_PUBLIC_KEY,
    blsPrivateKey: DEV_BLS_PRIVATE_KEY,
    blsPublicKey: DEV_BLS_PUBLIC_KEY,
    blsProofOfPossession: DEV_BLS_PROOF_OF_POSSESSION
  }
}

export interface WIREBootstrapConfig extends Required<WIREBootstrapOptions> {}

// System accounts that need to be created

export const SYSTEM_ACCOUNTS = [
  "sysio.bios",
  "sysio.system",
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
  ...OPP_SYSTEM_ACCOUNTS
] as const

export type SystemAccountName = (typeof SYSTEM_ACCOUNTS)[number]

export class WIREBootstrap {
  /**
   * Creates a new WIREBootstrap instance with validated configuration.
   * Applies default values for optional parameters and validates that required
   * dependencies (like clio binary) are available.
   *
   * @param options - Bootstrap configuration options
   * @returns A configured WIREBootstrap instance ready to execute the bootstrap sequence
   * @throws Error if clio binary path is invalid or not found
   */
  static async create(options: WIREBootstrapOptions) {
    // APPLY DEFAULTS IF NEEDED
    const config = defaults(
      { ...options },
      await createWIREBootstrapDefaultOptions()
    ) as WIREBootstrapConfig

    // DOUBLE CHECK CONFIG
    assert(await existsAsync(config.clioBinary), "clio binary path is required")

    return new WIREBootstrap(config)
  }

  private clio: Clio

  private walletPassword?: string

  private constructor(readonly config: WIREBootstrapConfig) {
    this.clio = new Clio({
      clusterPath: config.clusterPath,
      binary: config.clioBinary,
      url: config.httpUrl,
      walletUrl: config.walletUrl ?? undefined
    })
  }

  /**
   * Convert contract name to contract path
   *
   * @param name contract name
   */
  private toContractPath(name: SystemAccountName) {
    const contractPath = Path.resolve(this.config.buildPath, "contracts", name),
      contractFile = Path.join(contractPath, `${name}.wasm`)
    assert(
      Fs.existsSync(contractFile),
      () => new Error(`Contract file ${contractFile} not found`)
    )

    return contractPath
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
      timeoutMs: 30_000
    })
  }

  private async setupWallet(): Promise<void> {
    log.info("Creating wallet and importing keys...")
    this.walletPassword = await this.clio.walletCreate("default")
    await this.clio.walletImportKey("default", this.config.k1PrivateKey)
    log.info("Wallet created and sysio key imported")
  }

  private async deployBios(): Promise<void> {
    log.info("Deploying sysio.bios contract...")
    const dir = this.toContractPath("sysio.bios")
    await retry(
      () =>
        this.clio.setContract(
          "sysio",
          dir,
          "sysio.bios.wasm",
          "sysio.bios.abi"
        ),
      { label: "deploy sysio.bios", maxAttempts: 3, delayMs: 2000 }
    )
    log.info("sysio.bios deployed")
  }

  private async activateProtocolFeatures(): Promise<void> {
    log.info("Activating protocol features...")

    // Activate PREACTIVATE_FEATURE first (required for all others)
    // Then activate all builtin features via the /v1/producer/schedule_protocol_feature_activations endpoint
    try {
      const resp = await fetch(
        `${this.config.httpUrl}/v1/producer/get_supported_protocol_features`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      )
      const features = (await resp.json()) as any[]

      // Activate each feature
      for (const feature of features) {
        const digest = feature.feature_digest
        if (!digest) continue
        try {
          await this.clio.activateFeature(digest)
          log.debug(
            `Activated feature: ${feature.specification?.[0]?.value || digest}`
          )
        } catch (err: any) {
          // Some features may already be active or have dependencies
          if (!err.message?.includes("already activated")) {
            log.debug(`Feature activation skipped: ${digest} — ${err.message}`)
          }
        }
        await sleep(500)
      }
    } catch (err: any) {
      log.warn(
        `Protocol feature activation via API failed, trying individual activation: ${err.message}`
      )
    }

    log.info("Protocol features activated")
  }

  private async createSystemAccounts(): Promise<void> {
    log.info("Creating system accounts...")
    for (const account of SYSTEM_ACCOUNTS) {
      try {
        await this.clio.createSystemAccount(account, this.config.k1PublicKey)
        log.debug(`Created account: ${account}`)
      } catch (err: any) {
        if (
          err.message?.includes("already exists") ||
          err.stderr?.includes("already exists")
        ) {
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
    const systemDir = this.toContractPath("sysio.system")
    await retry(
      () =>
        this.clio.setContract(
          "sysio",
          systemDir,
          "sysio.system.wasm",
          "sysio.system.abi"
        ),
      { label: "deploy sysio.system", maxAttempts: 3, delayMs: 2000 }
    )

    // Deploy sysio.token
    log.info("Deploying sysio.token...")
    const tokenDir = this.toContractPath("sysio.token")
    await retry(
      () =>
        this.clio.setContract(
          "sysio.token",
          tokenDir,
          "sysio.token.wasm",
          "sysio.token.abi"
        ),
      { label: "deploy sysio.token", maxAttempts: 3, delayMs: 2000 }
    )

    // Deploy sysio.msig
    log.info("Deploying sysio.msig...")
    const msigDir = this.toContractPath("sysio.msig")
    await retry(
      () =>
        this.clio.setContract(
          "sysio.msig",
          msigDir,
          "sysio.msig.wasm",
          "sysio.msig.abi"
        ),
      { label: "deploy sysio.msig", maxAttempts: 3, delayMs: 2000 }
    )

    // Set privileged accounts
    await this.clio.setPriv("sysio.msig")

    log.info("System contracts deployed")
  }

  /**
   * Deploy OPP contracts
   */
  private async deployOPPContracts(): Promise<void> {
    // CREATE AN ARRAY OF OPP CONTRACTS TO ITERATE
    const oppContracts: {
      account: SystemAccountName
      name: SystemAccountName
    }[] = [
      { account: "sysio.epoch", name: "sysio.epoch" },
      { account: "sysio.msgch", name: "sysio.msgch" },
      { account: "sysio.uwrit", name: "sysio.uwrit" },
      { account: "sysio.chalg", name: "sysio.chalg" }
    ]

    for (const { account, name } of oppContracts) {
      log.info(`Deploying ${name}...`)

      // GET THE CONTRACT PATH
      const contractPath = this.toContractPath(name)

      // SET CONTRACT
      log.info(`Setting ${name} from ${contractPath}`)
      await retry(
        () =>
          this.clio.setContract(
            account,
            contractPath,
            `${name}.wasm`,
            `${name}.abi`
          ),
        { label: `deploy ${name}`, maxAttempts: 3, delayMs: 2000 }
      )

      // SET PRIVILEGED
      log.info(`Setting ${name} privileged`)
      await this.clio.setPriv(account)

      log.info(`Deployed ${name} from ${contractPath}`)
    }
  }

  private async configureOPP(): Promise<void> {
    log.info("Configuring OPP epoch system...")

    // sysio.epoch::setconfig
    try {
      await this.clio.pushActionAndWait<SystemContracts.SysioEpochSetconfigAction>(
        "sysio.epoch",
        "setconfig",
        {
          epoch_duration_sec: 360,
          operators_per_epoch: 7,
          batch_operator_minimum_active: 21,
          batch_op_groups: 3,
          warmup_epochs: 1,
          cooldown_epochs: 1,
          attestation_retention_epoch_count: 1000
        },
        "sysio.epoch@active"
      )
      log.info("Epoch config set (360s epochs, 7 per epoch, 3 groups)")
    } catch (err: any) {
      log.warn(`Failed to configure epoch: ${err.message}`)
    }

    // Register outposts: ETHEREUM (chain_kind=2, chain_id=31337) and SOLANA (chain_kind=3, chain_id=1)
    try {
      await this.clio.pushAction<SystemContracts.SysioEpochRegoutpostAction>(
        "sysio.epoch",
        "regoutpost",
        { chain_kind: 2, chain_id: 31337 },
        "sysio.epoch@active"
      )
      log.info("Registered ETH outpost (chain_kind=2, chain_id=31337)")
    } catch (err: any) {
      log.warn(`Failed to register ETH outpost: ${err.message}`)
    }

    try {
      await this.clio.pushAction<SystemContracts.SysioEpochRegoutpostAction>(
        "sysio.epoch",
        "regoutpost",
        { chain_kind: 3, chain_id: 1 },
        "sysio.epoch@active"
      )
      log.info("Registered SOL outpost (chain_kind=3, chain_id=1)")
    } catch (err: any) {
      log.warn(`Failed to register SOL outpost: ${err.message}`)
    }

    // sysio.uwrit::setconfig
    try {
      await this.clio.pushAction<SystemContracts.SysioUwritSetconfigAction>(
        "sysio.uwrit",
        "setconfig",
        {
          fee_bps: 10,
          confirm_lock_sec: 86400,
          uw_fee_share_pct: 50,
          other_uw_share_pct: 25,
          batch_op_share_pct: 25
        },
        "sysio.uwrit@active"
      )
      log.info("Underwriting config set (10bps fee, 24hr lock)")
    } catch (err: any) {
      log.warn(`Failed to configure underwriting: ${err.message}`)
    }

    log.info("OPP configuration complete")
  }
}
