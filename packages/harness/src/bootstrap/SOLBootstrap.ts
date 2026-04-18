import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL
} from "@solana/web3.js"
import * as anchor from "@coral-xyz/anchor"
import Path from "path"
import Fs from "fs"
import { SOLClient } from "../clients/SOLClient.js"
import { log } from "../logger.js"
import { retry, sleep } from "../util.js"

/**
 * Solana outpost bootstrap.
 *
 * Runs against a test validator that already has the `opp_outpost` program
 * loaded (via `--bpf-program` at validator launch). Responsibilities:
 *   - Airdrop SOL to a deployer keypair
 *   - Initialize the `OutpostConfig` / `MessageBuffer` / `OperatorRegistry` PDAs
 *
 * Per-epoch `EpochDeliveries` PDAs are allocated lazily on first delivery by
 * the batch operator — nothing to do here.
 */

export interface SOLBootstrapConfig {
  /** Path to wire-solana repo root. */
  wireSolPath: string
  /** RPC URL of the test validator. */
  rpcUrl: string
  /** Path to deployer keypair (default: ~/.config/solana/id.json). */
  deployerKeypair?: string
  /** Program keypair for the opp-outpost program. */
  programKeypairFile?: string
  /** Initial consensus threshold; overridden by the first inbound
   *  BATCH_OPERATOR_GROUPS attestation. Defaults to 1 so the bootstrap epoch
   *  can land with a single delivery. */
  consensusThreshold?: number
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

  /**
   * Airdrop SOL to a list of accounts (base58 public keys).
   * Called on every `run` to refund batch operator signing accounts after --reset wipes the ledger.
   */
  async airdropAccounts(
    pubkeys: string[],
    amountSol = 100
  ): Promise<void> {
    const lamports = amountSol * LAMPORTS_PER_SOL
    await Promise.all(
      pubkeys.map(async pk => {
        const pub = new PublicKey(pk)
        await retry(
          async () => {
            const sig = await this.connection.requestAirdrop(pub, lamports)
            const deadline = Date.now() + 60_000
            while (Date.now() < deadline) {
              const status = await this.connection.getSignatureStatus(sig)
              const conf = status?.value?.confirmationStatus
              if (conf === "confirmed" || conf === "finalized") break
              if (status?.value?.err)
                throw new Error(
                  `Airdrop tx failed: ${JSON.stringify(status.value.err)}`
                )
              await sleep(500)
            }
            if (Date.now() >= deadline)
              throw new Error("Airdrop not confirmed within 60s")
          },
          { label: `airdrop to ${pk}`, maxAttempts: 3, delayMs: 2000 }
        )
        log.info(`Airdropped ${amountSol} SOL to ${pk}`)
      })
    )
  }

  /** Run the full Solana outpost deployment. */
  async bootstrap(): Promise<void> {
    log.info("=== Solana Outpost Bootstrap ===")

    // 1. Load program keypair to get program ID
    const programKeypairFile =
      this.config.programKeypairFile ??
      Path.join(this.config.wireSolPath, "wallets", "opp-outpost-keypair.json")

    if (Fs.existsSync(programKeypairFile)) {
      const keypairData = JSON.parse(Fs.readFileSync(programKeypairFile, "utf8"))
      const programKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData))
      this.programId = programKeypair.publicKey
      log.info(`OPP Outpost program ID: ${this.programId.toBase58()}`)
    } else {
      log.warn(`Program keypair not found at ${programKeypairFile}`)
    }

    // 2. Verify the program is already deployed (via --bpf-program on validator start)
    if (this.programId) {
      const accountInfo = await this.connection.getAccountInfo(this.programId)
      if (accountInfo?.executable) {
        log.info("OPP Outpost program is loaded on the validator")
      } else {
        log.warn(
          "OPP Outpost program not found on validator — it should be deployed via --bpf-program flag on solana-test-validator"
        )
      }
    }

    // 3. Airdrop to deployer for transactions
    const deployerKeypairFile =
      this.config.deployerKeypair ??
      Path.join(process.env.HOME || "~", ".config", "solana", "id.json")

    let deployer: Keypair
    if (Fs.existsSync(deployerKeypairFile)) {
      const data = JSON.parse(Fs.readFileSync(deployerKeypairFile, "utf8"))
      deployer = Keypair.fromSecretKey(Uint8Array.from(data))
    } else {
      deployer = Keypair.generate()
      log.warn(
        `No deployer keypair found, using generated: ${deployer.publicKey.toBase58()}`
      )
    }

    log.info(`Deployer: ${deployer.publicKey.toBase58()}`)
    await retry(
      async () => {
        const sig = await this.connection.requestAirdrop(
          deployer.publicKey,
          100 * LAMPORTS_PER_SOL
        )
        // Poll signature status via HTTP to avoid the WebSocket dependency.
        // The Solana WebSocket (rpc+1) may conflict with other services on the
        // same host, making confirmTransaction unreliable during cluster create.
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const status = await this.connection.getSignatureStatus(sig)
          const conf = status?.value?.confirmationStatus
          if (conf === "confirmed" || conf === "finalized") break
          if (status?.value?.err) throw new Error(`Airdrop tx failed: ${JSON.stringify(status.value.err)}`)
          await sleep(500)
        }
        if (Date.now() >= deadline) throw new Error("Airdrop not confirmed within 60s")
      },
      { label: "airdrop to deployer", maxAttempts: 3, delayMs: 2000 }
    )

    // 4. Initialize PDAs if program is deployed
    if (this.programId) {
      await this.initializePDAs(deployer)
    }

    log.info("=== Solana Outpost Bootstrap Complete ===")
  }

  private async initializePDAs(deployer: Keypair): Promise<void> {
    log.info("Initializing OPP Outpost PDAs...")

    // Derive PDAs — seeds must match the on-chain program (see
    // wire-solana/programs/opp-outpost/src/state/*.rs).
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outpost_config")],
      this.programId!
    )
    const [messageBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_buffer")],
      this.programId!
    )
    const [operatorRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator_registry")],
      this.programId!
    )

    log.info(`  Config PDA:    ${configPda.toBase58()}`)
    log.info(`  MsgBuffer PDA: ${messageBufferPda.toBase58()}`)
    log.info(`  Registry PDA:  ${operatorRegistryPda.toBase58()}`)

    // If the config PDA already exists, assume a prior bootstrap finished.
    const configAccount = await this.connection.getAccountInfo(configPda)
    if (configAccount && configAccount.data.length > 0) {
      log.info("PDAs already initialized, skipping")
      return
    }

    const wallet = new anchor.Wallet(deployer)
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed"
    })

    // Anchor's IDL path — matches the Rust program mod name (`opp_outpost`).
    const idlFile = Path.join(
      this.config.wireSolPath,
      "target",
      "idl",
      "opp_outpost.json"
    )
    if (!Fs.existsSync(idlFile)) {
      log.warn(`IDL not found at ${idlFile} — skipping PDA initialization`)
      return
    }

    const idl = JSON.parse(Fs.readFileSync(idlFile, "utf8"))
    const program = new anchor.Program(idl, provider)

    const consensusThreshold = this.config.consensusThreshold ?? 1

    // Build tx and send+confirm via HTTP polling. Anchor's .rpc() uses the
    // deprecated confirmTransaction (30s wall-clock) which fails here because
    // the Solana WebSocket port (rpcPort+1) is occupied by another service.
    const tx = await program.methods
      .initialize(consensusThreshold)
      .accounts({
        authority: deployer.publicKey,
        config: configPda,
        messageBuffer: messageBufferPda,
        operatorRegistry: operatorRegistryPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()

    const initSig = await this.connection.sendTransaction(tx, [deployer], {
      skipPreflight: false
    })

    const initDeadline = Date.now() + 60_000
    while (Date.now() < initDeadline) {
      const status = await this.connection.getSignatureStatus(initSig)
      const conf = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") break
      if (status?.value?.err)
        throw new Error(`Initialize tx failed: ${JSON.stringify(status.value.err)}`)
      await sleep(500)
    }
    if (Date.now() >= initDeadline) throw new Error("Initialize not confirmed within 60s")

    log.info("PDAs initialized successfully")
  }
}
