import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { SlugName } from "@wireio/sdk-core"
import { OppSolProgram } from "./OppSolProgram.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { retry } from "../../utils/asyncUtils.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { SolanaOutpostProgramTool } from "../../tools/solana/SolanaOutpostProgramTool.js"

const log = getLogger(__filename)

/** Caller options for {@link SolanaOutpostBootstrapper}. */
export interface SolanaOutpostBootstrapperOptions {
  /** Path to the `wire-solana` repo root (holds the IDL + program keypair). */
  solanaPath: string
  /** RPC URL of the test validator. */
  rpcUrl: string
  /** Deployer keypair file (default: `~/.config/solana/id.json`). */
  deployerKeypairFile?: string
  /**
   * OPP outpost program keypair file (default:
   * `<solanaPath>/.keys/liqsol_core-keypair.json` — the outpost interface is
   * hosted in the `liqsol_core` program since the clean-room rewrite).
   */
  programKeypairFile?: string
  /**
   * Directory under which mock-SPL-mint metadata (`sol-mock-mints.json`) +
   * the deployer keypair are persisted for downstream token registration.
   * When `null`, SPL provisioning is skipped (native SOL still works).
   */
  clusterDataPath?: string | null
}

/** Resolved {@link SolanaOutpostBootstrapper} config (derived defaults filled in). */
export interface SolanaOutpostBootstrapperConfig {
  solanaPath: string
  rpcUrl: string
  deployerKeypairFile: string
  programKeypairFile: string
  clusterDataPath: string | null
}

/**
 * Bootstrap the Solana (test-validator) outpost: airdrop SOL to a deployer,
 * initialize the `OutpostConfig` / `OutboundMessageBuffer` / `OperatorRegistry`
 * (+ envelope-log + reserve) PDAs against the already-loaded `liqsol_core`
 * program (which hosts the OPP outpost interface), seed the native-SOL
 * reserve, and (when a cluster data path is given) provision mock SPL
 * reserves. The program is deployed upgradeable at validator launch (its
 * upgrade authority == the outpost `admin`); per-epoch `EpochDeliveries` PDAs
 * are allocated lazily by the batch operator on first delivery.
 *
 * Test-cluster custody priming (`provisionSplReserves`) lives HERE in the
 * harness, never in `wire-solana`'s deploy scripts.
 */
export class SolanaOutpostBootstrapper {
  private readonly config: SolanaOutpostBootstrapperConfig
  private readonly connection: Connection
  /** OPP outpost program id (resolved from the program keypair file), or null when absent. */
  programId: PublicKey | null = null
  /** liqsol `global_config` PDA, resolved in `ensureGlobalConfig`. */
  private globalConfigPda: PublicKey | null = null

  constructor(options: SolanaOutpostBootstrapperOptions) {
    Assert.ok(options.solanaPath, "SolanaOutpostBootstrapper: solanaPath is required")
    Assert.ok(options.rpcUrl, "SolanaOutpostBootstrapper: rpcUrl is required")
    this.config = {
      solanaPath: options.solanaPath,
      rpcUrl: options.rpcUrl,
      deployerKeypairFile:
        options.deployerKeypairFile ??
        (options.clusterDataPath != null
          ? OppSolProgram.clusterDeployerKeypairFile(options.clusterDataPath)
          : SolanaOutpostBootstrapper.defaultDeployerKeypairFile()),
      programKeypairFile:
        options.programKeypairFile ??
        SolanaOutpostProgramTool.programKeypairFile(options.solanaPath),
      clusterDataPath: options.clusterDataPath ?? null
    }
    this.connection = new Connection(options.rpcUrl, SolanaClient.DefaultCommitment)
  }

  /**
   * Airdrop SOL to a list of accounts (base58 public keys). Called on every
   * `run` to refund batch-operator signing accounts after `--reset` wipes the
   * ledger.
   */
  async airdropAccounts(
    publicKeys: string[],
    amountSol: number = SolanaOutpostBootstrapper.DefaultAirdropSol
  ): Promise<void> {
    const lamports = amountSol * LAMPORTS_PER_SOL
    await Promise.all(
      publicKeys.map(async base58 => {
        const publicKey = new PublicKey(base58)
        await retry(
          async () => {
            const signature = await this.connection.requestAirdrop(publicKey, lamports)
            await confirmSignature(this.connection, signature, `airdrop to ${base58}`)
          },
          {
            label: `airdrop to ${base58}`,
            maxAttempts: SolanaOutpostBootstrapper.AirdropRetryAttempts,
            delayMs: SolanaOutpostBootstrapper.AirdropRetryDelayMs
          }
        )
        log.info(`airdropped ${amountSol} SOL to ${base58}`)
      })
    )
  }

  /** Run the full Solana-outpost bootstrap sequence. */
  async bootstrap(): Promise<void> {
    log.info("=== Solana outpost bootstrap ===")

    if (Fs.existsSync(this.config.programKeypairFile)) {
      const keypairData = JSON.parse(Fs.readFileSync(this.config.programKeypairFile, "utf8"))
      this.programId = Keypair.fromSecretKey(Uint8Array.from(keypairData)).publicKey
      log.info(
        `${SolanaOutpostProgramTool.ProgramName} (OPP outpost) program id: ${this.programId.toBase58()}`
      )
      // The deploy step's payload: which program this outpost runs as (the
      // PDAs + reserve provisioning below record as solana RPC/tx calls).
      StepExtraRecorder.record({
        client: "harness",
        kind: "artifact",
        file: this.config.programKeypairFile,
        programId: this.programId.toBase58()
      })
    } else {
      log.warn(`program keypair not found at ${this.config.programKeypairFile}`)
    }

    if (this.programId != null) {
      const accountInfo = await this.connection.getAccountInfo(this.programId)
      if (accountInfo?.executable)
        log.info("OPP outpost program is loaded on the validator")
      else
        log.warn(
          "OPP outpost program not found on validator — it should be deployed upgradeable at launch"
        )
    }

    const deployer = this.loadOrGenerateDeployer()
    log.info(`deployer: ${deployer.publicKey.toBase58()}`)
    await retry(
      async () => {
        const signature = await this.connection.requestAirdrop(
          deployer.publicKey,
          SolanaOutpostBootstrapper.DefaultAirdropSol * LAMPORTS_PER_SOL
        )
        // Poll signature status via HTTP (no WebSocket dependency — the validator's
        // WS port may conflict with another service during cluster create).
        await confirmSignature(this.connection, signature, "airdrop to deployer")
      },
      {
        label: "airdrop to deployer",
        maxAttempts: SolanaOutpostBootstrapper.AirdropRetryAttempts,
        delayMs: SolanaOutpostBootstrapper.AirdropRetryDelayMs
      }
    )

    if (this.programId != null) await this.initializePDAs(deployer)
    log.info("=== Solana outpost bootstrap complete ===")
  }

  /**
   * Load the deployer keypair from disk, or generate one. Always persists the
   * keypair under the cluster data dir (when given) so flow tests can re-load it
   * to act as the same mint authority `provisionSplReserves` installed.
   */
  private loadOrGenerateDeployer(): Keypair {
    let deployer: Keypair
    if (Fs.existsSync(this.config.deployerKeypairFile)) {
      const data = JSON.parse(Fs.readFileSync(this.config.deployerKeypairFile, "utf8"))
      deployer = Keypair.fromSecretKey(Uint8Array.from(data))
    } else {
      deployer = Keypair.generate()
      log.warn(`no deployer keypair found, using generated: ${deployer.publicKey.toBase58()}`)
    }
    if (this.config.clusterDataPath != null) {
      mkdirs(this.config.clusterDataPath)
      const persistedFile = Path.join(this.config.clusterDataPath, "sol-deployer-keypair.json")
      Fs.writeFileSync(persistedFile, JSON.stringify(Array.from(deployer.secretKey)))
      log.info(`persisted SOL deployer keypair to ${persistedFile}`)
    }
    return deployer
  }

  /** Derive a program-derived address from `seed` under the opp-outpost program. */
  private deriveProgramAddress(programId: PublicKey, seed: string): PublicKey {
    const [address] = PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)
    return address
  }

  /** Derive a `(token_code, reserve_code)`-scoped PDA (reserve / reserve_vault). */
  private deriveReserveScopedAddress(
    programId: PublicKey,
    seed: string,
    tokenCode: number,
    reserveCode: number
  ): PublicKey {
    const [address] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(seed),
        SolanaOutpostBootstrapper.slugNameToLittleEndianBuffer(tokenCode),
        SolanaOutpostBootstrapper.slugNameToLittleEndianBuffer(reserveCode)
      ],
      programId
    )
    return address
  }

  private async initializePDAs(deployer: Keypair): Promise<void> {
    const programId = this.programId
    Assert.ok(programId != null, "initializePDAs: programId required")
    log.info("initializing OPP outpost PDAs...")

    const Seed = SolanaOutpostBootstrapper.PdaSeed
    const configPda = this.deriveProgramAddress(programId, Seed.OutpostConfig)
    const outboundMessageBufferPda = this.deriveProgramAddress(programId, Seed.OutboundMessageBuffer)
    const operatorRegistryPda = this.deriveProgramAddress(programId, Seed.OperatorRegistry)
    const inboundEnvelopesPda = this.deriveProgramAddress(programId, Seed.InboundEnvelopes)
    const outboundEnvelopesPda = this.deriveProgramAddress(programId, Seed.OutboundEnvelopes)
    const latestOutboundEnvelopePda = this.deriveProgramAddress(programId, Seed.LatestOutboundEnvelope)

    log.info(`  config:                 ${configPda.toBase58()}`)
    log.info(`  outboundMessageBuffer:  ${outboundMessageBufferPda.toBase58()}`)
    log.info(`  operatorRegistry:       ${operatorRegistryPda.toBase58()}`)
    log.info(`  inboundEnvelopes:       ${inboundEnvelopesPda.toBase58()}`)
    log.info(`  outboundEnvelopes:      ${outboundEnvelopesPda.toBase58()}`)
    log.info(`  latestOutboundEnvelope: ${latestOutboundEnvelopePda.toBase58()}`)

    const configAccount = await this.connection.getAccountInfo(configPda)
    if (configAccount != null && configAccount.data.length > 0) {
      log.info("PDAs already initialized, skipping")
      return
    }

    const provider = new anchor.AnchorProvider(this.connection, new anchor.Wallet(deployer), {
      commitment: SolanaClient.DefaultCommitment
    })
    const idlFile = SolanaOutpostProgramTool.programIdlFile(this.config.solanaPath)
    if (!Fs.existsSync(idlFile)) {
      log.warn(`IDL not found at ${idlFile} — skipping PDA initialization`)
      return
    }
    const idl = JSON.parse(Fs.readFileSync(idlFile, "utf8"))
    const program = new anchor.Program(idl, provider)

    // The OPP admin ops are gated by the liqsol `global_config`
    // (`has_one = admin`), which must be initialized once before the outpost.
    await this.ensureGlobalConfig(deployer, program)

    // `initialize_outpost` takes only the outpost's `chain_code`
    // (SOL ⇒ "SOLANA"_c) — consensus thresholds are derived on-the-fly per
    // `epoch_in` and the epoch duration is propagated via the
    // BATCH_OPERATOR_GROUPS attestation. (The clean-room rename: liqsol_core's
    // own staking `initialize` already claims the bare name.)
    const solanaChainCode = new anchor.BN(SlugName.from(SolanaOutpostBootstrapper.SolanaChainCodename))
    const initializeTransaction = await program.methods
      .initializeOutpost(solanaChainCode)
      .accounts({
        ...this.oppAdminAccounts(deployer),
        config: configPda,
        outboundMessageBuffer: outboundMessageBufferPda,
        operatorRegistry: operatorRegistryPda,
        inboundEnvelopes: inboundEnvelopesPda,
        outboundEnvelopes: outboundEnvelopesPda,
        latestOutboundEnvelope: latestOutboundEnvelopePda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(deployer, initializeTransaction, "initialize_outpost")
    log.info("PDAs initialized successfully")

    // Register the native-SOL binding (mint = all-zeroes `PublicKey.default`)
    // so `deposit(SOL_CODE, ...)` doesn't revert with `TokenCodeNotConfigured`.
    const solTokenCode = new anchor.BN(SlugName.from(SolanaOutpostBootstrapper.SolTokenCodename))
    const setTokenAddressTransaction = await program.methods
      .setTokenAddress(solTokenCode, anchor.web3.PublicKey.default)
      .accounts({ ...this.oppAdminAccounts(deployer), config: configPda })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(deployer, setTokenAddressTransaction, "set_token_address")
    log.info("SOL native-token binding registered")

    // Precision is REQUIRED for every registered token — the program's
    // `PrecisionUnconfigured` gate and wire-ethereum's
    // `WIRE_TokenPrecisionUnset` are the same contract (no silent defaults).
    // Bind native SOL's 9 (lamports) right after its address binding so
    // `create_reserve_native` and every SOL swap path can frame-convert.
    const setSolPrecisionTransaction = await program.methods
      .setTokenPrecision(solTokenCode, SolanaOutpostBootstrapper.SolTokenDecimals)
      .accounts({ ...this.oppAdminAccounts(deployer), config: configPda })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(
      deployer,
      setSolPrecisionTransaction,
      "set_token_precision(SOL)"
    )
    log.info("SOL native-token precision registered")

    // Initialize the ReserveAggregate PDA — `epoch_in` declares it as a writable
    // account, so without it every inbound delivery fails at simulation.
    const reserveAggregatePda = this.deriveProgramAddress(programId, Seed.ReserveAggregate)
    log.info(`  reserveAggregate:       ${reserveAggregatePda.toBase58()}`)
    const initReserveTransaction = await program.methods
      .initReserve()
      .accounts({
        payer: deployer.publicKey,
        ...this.oppAdminAccounts(deployer),
        config: configPda,
        reserveAggregate: reserveAggregatePda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(deployer, initReserveTransaction, "init_reserve")
    log.info("SOL ReserveAggregate PDA initialized")

    // Bootstrap-seeded native SOL reserve — the outpost-side mirror of the
    // depot's SOLANA/SOL/PRIMARY row. `create_reserve_native` is the
    // authority-gated, NATIVE-only bootstrap-symmetry IX (no SPL Mint/ATA, no
    // RESERVE_CREATE attestation; status=Active set inline).
    const solReserveCode = new anchor.BN(SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename))
    const nativeReserveAmount = new anchor.BN(SolanaOutpostBootstrapper.BootstrapNativeReserveLamports)
    const solReservePda = this.deriveReserveScopedAddress(
      programId,
      Seed.Reserve,
      SlugName.from(SolanaOutpostBootstrapper.SolTokenCodename),
      SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename)
    )
    log.info(`  reserve (SOL/PRIMARY):  ${solReservePda.toBase58()}`)
    const createReserveTransaction = await program.methods
      .createReserveNative(
        solTokenCode,
        solReserveCode,
        nativeReserveAmount,
        nativeReserveAmount,
        SolanaOutpostBootstrapper.BootstrapConnectorWeightBps,
        "SOLANA-SOL/WIRE primary reserve",
        "Bootstrap-seeded native SOL ↔ WIRE reserve (outpost-side custody)"
      )
      .accounts({
        payer: deployer.publicKey,
        ...this.oppAdminAccounts(deployer),
        config: configPda,
        reserve: solReservePda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(
      deployer,
      createReserveTransaction,
      "create_reserve_native"
    )
    log.info(
      `SOL native reserve seeded (PDA=${solReservePda.toBase58()}, lamports=${SolanaOutpostBootstrapper.BootstrapNativeReserveLamports})`
    )

    if (this.config.clusterDataPath != null)
      await this.provisionSplReserves(deployer, program, configPda)
  }

  /**
   * Provision mock SPL reserves (USDCSOL, USDTSOL, LIQSOL): create each mint,
   * fund the deployer ATA, bind via `set_token_address` + `set_token_precision`,
   * then `create_reserve_spl_authority` to allocate the per-reserve vault seeded
   * with bootstrap liquidity. Persists the mint pubkeys to
   * `<clusterDataPath>/sol-mock-mints.json` for depot-side token registration.
   */
  private async provisionSplReserves(
    deployer: Keypair,
    program: anchor.Program<anchor.Idl>,
    configPda: PublicKey
  ): Promise<void> {
    const clusterDataPath = this.config.clusterDataPath
    const programId = this.programId
    Assert.ok(clusterDataPath != null, "provisionSplReserves: clusterDataPath required")
    Assert.ok(programId != null, "provisionSplReserves: programId required")
    log.info("[solana] provisioning mock SPL reserves (USDCSOL, USDTSOL, LIQSOL)...")

    const primaryCode = new anchor.BN(SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename))
    const persisted: SolanaOutpostBootstrapper.PersistedSplMint[] = []

    // Sequential: each step depends on the previous landing on-chain.
    await mapSeries(
      SolanaOutpostBootstrapper.SplReserveSpecifications,
      async specification => {
        const code = SlugName.from(specification.codeName)
        const codeBigNumber = new anchor.BN(code)
        log.info(
          `[solana]  - creating mock SPL mint for ${specification.codeName} (decimals=${specification.decimals})`
        )
        const mint = await SolanaFundingTool.createMockSplMint(
          this.connection,
          deployer,
          specification.decimals
        )
        log.info(`[solana]    mint=${mint.toBase58()}`)

        const deployerAta = await SolanaFundingTool.mintMockSplToUser(
          this.connection,
          deployer,
          mint,
          deployer.publicKey,
          specification.chainAmount * 2n
        )
        log.info(`[solana]    deployer ATA funded (ata=${deployerAta.toBase58()})`)

        const setAddressTransaction = await program.methods
          .setTokenAddress(codeBigNumber, mint)
          .accounts({ ...this.oppAdminAccounts(deployer), config: configPda })
          .signers([deployer])
          .transaction()
        await this.runSimpleAuthorityInstruction(
          deployer,
          setAddressTransaction,
          `set_token_address(${specification.codeName})`
        )

        const setPrecisionTransaction = await program.methods
          .setTokenPrecision(codeBigNumber, specification.decimals)
          .accounts({ ...this.oppAdminAccounts(deployer), config: configPda })
          .signers([deployer])
          .transaction()
        await this.runSimpleAuthorityInstruction(
          deployer,
          setPrecisionTransaction,
          `set_token_precision(${specification.codeName})`
        )

        const reservePda = this.deriveReserveScopedAddress(
          programId,
          SolanaOutpostBootstrapper.PdaSeed.Reserve,
          code,
          SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename)
        )
        const reserveVaultPda = this.deriveReserveScopedAddress(
          programId,
          SolanaOutpostBootstrapper.PdaSeed.ReserveVault,
          code,
          SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename)
        )
        const chainAmount = new anchor.BN(specification.chainAmount.toString())
        const createTransaction = await program.methods
          .createReserveSplAuthority(
            codeBigNumber,
            primaryCode,
            chainAmount,
            chainAmount,
            SolanaOutpostBootstrapper.BootstrapConnectorWeightBps,
            `SOLANA-${specification.codeName}/WIRE primary reserve`,
            `Bootstrap-seeded mock ${specification.codeName} ↔ WIRE reserve (outpost-side custody)`
          )
          .accounts({
            payer: deployer.publicKey,
            ...this.oppAdminAccounts(deployer),
            config: configPda,
            reserve: reservePda,
            reserveVault: reserveVaultPda,
            mint,
            adminAta: deployerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY
          })
          .signers([deployer])
          .transaction()
        await this.runSimpleAuthorityInstruction(
          deployer,
          createTransaction,
          `create_reserve_spl_authority(${specification.codeName}/PRIMARY)`
        )

        persisted.push({ code, mint: mint.toBase58(), decimals: specification.decimals })
        log.info(`[solana]    reserve PDA seeded (${specification.codeName}/PRIMARY)`)
      }
    )

    mkdirs(clusterDataPath)
    const persistedFile = Path.join(clusterDataPath, "sol-mock-mints.json")
    Fs.writeFileSync(persistedFile, JSON.stringify(persisted, null, 2))
    log.info(`[solana] persisted ${persisted.length} mock SPL mint(s) to ${persistedFile}`)
  }

  /**
   * The signer/authority accounts every OPP admin instruction shares: the
   * liqsol program takes `admin` + the gating `global_config` PDA
   * (`has_one = admin`).
   *
   * @param deployer - the deployer keypair (the outpost `admin`).
   * @return the account fragment to spread into an admin instruction's `.accounts`.
   */
  private oppAdminAccounts(
    deployer: Keypair
  ): SolanaOutpostBootstrapper.OppAdminAccounts {
    Assert.ok(
      this.globalConfigPda != null,
      "oppAdminAccounts: global_config not initialized"
    )
    return { admin: deployer.publicKey, globalConfig: this.globalConfigPda }
  }

  /**
   * Initialize the liqsol `global_config` PDA (idempotent) so its `admin` is set
   * to the program's on-chain upgrade authority — which the validator launched
   * as this same `deployer`. Every OPP admin op then passes `admin = deployer`
   * and `global_config` to satisfy the `has_one = admin` gate.
   *
   * @param deployer - the deployer keypair (== program upgrade authority).
   * @param program - the liqsol Anchor program bound to the deployer.
   */
  private async ensureGlobalConfig(
    deployer: Keypair,
    program: anchor.Program<anchor.Idl>
  ): Promise<void> {
    const programId = this.programId
    Assert.ok(programId != null, "ensureGlobalConfig: programId required")
    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from(OppSolProgram.globalConfigSeed)],
      programId
    )
    this.globalConfigPda = globalConfig
    const existing = await this.connection.getAccountInfo(globalConfig)
    if (existing != null && existing.data.length > 0) {
      log.info("liqsol global_config already initialized")
      return
    }
    const [programData] = PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      new PublicKey(OppSolProgram.bpfLoaderUpgradeableProgramId)
    )
    const transaction = await program.methods
      .initializeGlobalConfig()
      .accounts({
        globalConfig,
        payer: deployer.publicKey,
        program: programId,
        programData,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(deployer, transaction, "initialize_global_config")
    log.info(`liqsol global_config initialized (admin=${deployer.publicKey.toBase58()})`)
  }

  /**
   * Submit a pre-built transaction signed by `signer`, then poll-confirm it.
   * Shared by `set_token_address` / `set_token_precision` / the reserve-create
   * IXs to keep `provisionSplReserves` focused on orchestration.
   */
  private async runSimpleAuthorityInstruction(
    signer: Keypair,
    transaction: anchor.web3.Transaction,
    label: string
  ): Promise<void> {
    const signature = await this.connection.sendTransaction(transaction, [signer], {
      skipPreflight: false
    })
    await confirmSignature(this.connection, signature, label)
  }
}

export namespace SolanaOutpostBootstrapper {
  /** Total attempts allowed for each airdrop / RPC retry block. */
  export const AirdropRetryAttempts = 3
  /** Delay between airdrop / RPC retries (ms). */
  export const AirdropRetryDelayMs = 2_000
  /** Default airdrop size (SOL) for the deployer + refunded signing accounts. */
  export const DefaultAirdropSol = 100
  /**
   * Lamports the bootstrap-seeded native SOL Reserve PDA is funded with — sized
   * for ~40 swap-with-underwriting runs (~0.5 SOL each) plus the rent floor.
   */
  export const BootstrapNativeReserveLamports = 20 * LAMPORTS_PER_SOL
  /** Bancor connector weight (basis points) for the bootstrap-seeded reserves. */
  export const BootstrapConnectorWeightBps = 5000

  /** The outpost's own chain codename on the depot's chain registry. */
  export const SolanaChainCodename = "SOLANA"
  /** Native SOL token codename. */
  export const SolTokenCodename = "SOL"
  /** Native SOL chain decimals (lamports) — bound via `set_token_precision`. */
  export const SolTokenDecimals = 9
  /** Default reserve codename. */
  export const PrimaryReserveCodename = "PRIMARY"

  /** Program-derived-address seeds — MUST match `wire-solana/programs/liqsol-core/src/states/opp_states.rs`. */
  export namespace PdaSeed {
    export const OutpostConfig = "outpost_config"
    export const OutboundMessageBuffer = "outbound_message_buffer"
    export const OperatorRegistry = "operator_registry"
    export const InboundEnvelopes = "inbound_envelopes"
    export const OutboundEnvelopes = "outbound_envelopes"
    export const LatestOutboundEnvelope = "latest_outbound_envelope"
    export const ReserveAggregate = "reserve_aggregate"
    export const Reserve = "reserve"
    export const ReserveVault = "reserve_vault"
  }

  /**
   * The shared signer/gating accounts every OPP admin instruction takes: the
   * liqsol program's `admin` + the `global_config` PDA it checks `has_one`
   * against. Spread into an admin instruction's `.accounts({ ... })`.
   */
  export interface OppAdminAccounts {
    /** The outpost admin (== the deployer / program upgrade authority). */
    admin: PublicKey
    /** The gating `global_config` PDA (`has_one = admin`). */
    globalConfig: PublicKey
  }

  /**
   * Persisted mock-SPL-mint metadata (consumed by depot-side token
   * registration): a `(slug_name code, base58 mint, decimals)` triple.
   */
  export interface PersistedSplMint {
    /** Slug-name codename packed into its `u64`-equivalent number. */
    code: number
    /** Base58 mint pubkey. */
    mint: string
    /** Chain-native decimals (6 for USDC/USDT, 9 for LIQSOL). */
    decimals: number
  }

  /** A mock SPL reserve to provision: codename, decimals, bootstrap chain-side amount. */
  export interface SplReserveSpecification {
    codeName: string
    decimals: number
    chainAmount: bigint
  }

  /**
   * The mock SPL reserves provisioned at bootstrap. USDCSOL/USDTSOL use 6
   * decimals (mainnet parity); LIQSOL uses 9 (depot parity). Distinct SOL-side
   * slug_names (`USDCSOL`/`USDTSOL`) per the v6 "two Token rows per pair" rule.
   */
  export const SplReserveSpecifications: ReadonlyArray<SplReserveSpecification> = [
    { codeName: "USDCSOL", decimals: 6, chainAmount: 1_000_000n * 1_000_000n },
    { codeName: "USDTSOL", decimals: 6, chainAmount: 1_000_000n * 1_000_000n },
    { codeName: "LIQSOL", decimals: 9, chainAmount: 20n * 1_000_000_000n }
  ]

  /** Default deployer keypair file (`~/.config/solana/id.json`). */
  export function defaultDeployerKeypairFile(): string {
    return Path.join(process.env.HOME || "~", ".config", "solana", "id.json")
  }

  /**
   * Encode a `number` slug_name as an 8-byte little-endian Buffer matching the
   * program's `to_le_bytes()` seed derivation.
   */
  export function slugNameToLittleEndianBuffer(value: number): Buffer {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(value))
    return buffer
  }
}
