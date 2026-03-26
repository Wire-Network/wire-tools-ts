import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import * as anchor from "@coral-xyz/anchor"
import Path from "path"
import Fs from "fs"
import { SOLClient } from "../clients/SOLClient.js"
import { log } from "../logger.js"
import { retry, sleep } from "../util.js"

/**
 * Solana outpost bootstrap.
 *
 * Deploys the opp-solana-outpost Anchor program on a running
 * solana-test-validator and initializes all PDAs.
 */

export interface SOLBootstrapConfig {
  /** Path to wire-solana repo root */
  wireSolDir: string
  /** RPC URL of the test validator */
  rpcUrl: string
  /** Path to deployer keypair (default: ~/.config/solana/id.json) */
  deployerKeypair?: string
  /** Program keypair for OPP outpost */
  programKeypairPath?: string
}

export class SOLBootstrap {
  private connection: Connection
  private config: SOLBootstrapConfig
  private client: SOLClient
  public programId?: PublicKey

  constructor(config: SOLBootstrapConfig) {
    this.config = config
    this.connection = new Connection(config.rpcUrl, "confirmed")
    this.client = new SOLClient(config.rpcUrl)
  }

  get solClient(): SOLClient {
    return this.client
  }

  /** Run the full Solana outpost deployment */
  async bootstrap(): Promise<void> {
    log.info("=== Solana Outpost Bootstrap ===")

    // 1. Load program keypair to get program ID
    const programKeypairPath = this.config.programKeypairPath ||
      Path.join(this.config.wireSolDir, "wallets", "opp-outpost-keypair.json")

    if (Fs.existsSync(programKeypairPath)) {
      const keypairData = JSON.parse(Fs.readFileSync(programKeypairPath, "utf8"))
      const programKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData))
      this.programId = programKeypair.publicKey
      log.info(`OPP Outpost program ID: ${this.programId.toBase58()}`)
    } else {
      log.warn(`Program keypair not found at ${programKeypairPath}`)
    }

    // 2. Check if program is already deployed (via --bpf-program on validator start)
    if (this.programId) {
      const accountInfo = await this.connection.getAccountInfo(this.programId)
      if (accountInfo && accountInfo.executable) {
        log.info("OPP Outpost program already deployed on validator")
      } else {
        log.warn("OPP Outpost program not found on validator — it should be deployed via --bpf-program flag on solana-test-validator")
      }
    }

    // 3. Airdrop to deployer for transactions
    const deployerKeypairPath = this.config.deployerKeypair ||
      Path.join(process.env.HOME || "~", ".config", "solana", "id.json")

    let deployer: Keypair
    if (Fs.existsSync(deployerKeypairPath)) {
      const data = JSON.parse(Fs.readFileSync(deployerKeypairPath, "utf8"))
      deployer = Keypair.fromSecretKey(Uint8Array.from(data))
    } else {
      deployer = Keypair.generate()
      log.warn(`No deployer keypair found, using generated: ${deployer.publicKey.toBase58()}`)
    }

    log.info(`Deployer: ${deployer.publicKey.toBase58()}`)
    await retry(async () => {
      const sig = await this.connection.requestAirdrop(deployer.publicKey, 100 * LAMPORTS_PER_SOL)
      await this.connection.confirmTransaction(sig)
    }, { label: "airdrop to deployer", maxAttempts: 5, delayMs: 2000 })

    // 4. Initialize PDAs if program is deployed
    if (this.programId) {
      await this.initializePDAs(deployer)
    }

    log.info("=== Solana Outpost Bootstrap Complete ===")
  }

  private async initializePDAs(deployer: Keypair): Promise<void> {
    log.info("Initializing OPP Outpost PDAs...")

    // Derive PDAs
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outpost_config")], this.programId!
    )
    const [epochStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch_state")], this.programId!
    )
    const [operatorRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator_registry")], this.programId!
    )
    const [messageBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_buffer")], this.programId!
    )

    log.info(`  Config PDA:     ${configPda.toBase58()}`)
    log.info(`  EpochState PDA: ${epochStatePda.toBase58()}`)
    log.info(`  Registry PDA:   ${operatorRegistryPda.toBase58()}`)
    log.info(`  MsgBuffer PDA:  ${messageBufferPda.toBase58()}`)

    // Check if already initialized
    const configAccount = await this.connection.getAccountInfo(configPda)
    if (configAccount && configAccount.data.length > 0) {
      log.info("PDAs already initialized, skipping")
      return
    }

    // Build and send initialize transaction via Anchor
    try {
      // Set up Anchor provider
      const wallet = new anchor.Wallet(deployer)
      const provider = new anchor.AnchorProvider(this.connection, wallet, {
        commitment: "confirmed",
      })

      // Load IDL from build artifacts
      const idlPath = Path.join(
        this.config.wireSolDir, "target", "idl", "opp_solana_outpost.json"
      )
      if (!Fs.existsSync(idlPath)) {
        log.warn(`IDL not found at ${idlPath} — skipping PDA initialization`)
        return
      }

      const idl = JSON.parse(Fs.readFileSync(idlPath, "utf8"))
      const program = new anchor.Program(idl, provider)

      const epochSecs = new anchor.BN(360) // 6 minutes

      await program.methods
        .initialize(epochSecs)
        .accounts({
          authority: deployer.publicKey,
          config: configPda,
          epochState: epochStatePda,
          operatorRegistry: operatorRegistryPda,
          messageBuffer: messageBufferPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([deployer])
        .rpc()

      log.info("PDAs initialized successfully")
    } catch (err: any) {
      log.warn(`PDA initialization failed: ${err.message}`)
    }
  }
}
