import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey
} from "@solana/web3.js"
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { SlugName } from "@wireio/sdk-core"
import { OperatorStatus, OperatorType } from "@wireio/opp-typescript-models"
import { mapSeries } from "../../utils/asyncUtils.js"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { getLogger } from "../../logging/Logger.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { retry } from "../../utils/asyncUtils.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { slugNameToLittleEndianBuffer } from "../../utils/slugUtils.js"
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
    Assert.ok(
      options.solanaPath,
      "SolanaOutpostBootstrapper: solanaPath is required"
    )
    Assert.ok(options.rpcUrl, "SolanaOutpostBootstrapper: rpcUrl is required")
    this.config = {
      solanaPath: options.solanaPath,
      rpcUrl: options.rpcUrl,
      deployerKeypairFile:
        options.deployerKeypairFile ??
        (options.clusterDataPath != null
          ? SolanaFundingTool.deployerKeypairFile(options.clusterDataPath)
          : SolanaOutpostBootstrapper.defaultDeployerKeypairFile()),
      clusterDataPath: options.clusterDataPath ?? null
    }
    this.connection = new Connection(
      options.rpcUrl,
      SolanaClient.DefaultCommitment
    )
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
            const signature = await this.connection.requestAirdrop(
              publicKey,
              lamports
            )
            await confirmSignature(
              this.connection,
              signature,
              `airdrop to ${base58}`
            )
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

    const { solanaPath } = this.config,
      programKeypairFile = SolanaOutpostProgramTool.programKeypairFile(solanaPath)
    this.programId = SolanaOutpostProgramTool.programId(solanaPath)
    if (this.programId != null) {
      log.info(
        `${SolanaOutpostProgramTool.ProgramName} (OPP outpost) program id: ${this.programId.toBase58()}`
      )
      // The deploy step's payload: which program this outpost runs as (the
      // PDAs + reserve provisioning below record as solana RPC/tx calls).
      StepExtraRecorder.record({
        client: "harness",
        kind: "artifact",
        file: programKeypairFile,
        programId: this.programId.toBase58()
      })
    } else {
      log.warn(`program keypair not found at ${programKeypairFile}`)
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
        await confirmSignature(
          this.connection,
          signature,
          "airdrop to deployer"
        )
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
      const data = JSON.parse(
        Fs.readFileSync(this.config.deployerKeypairFile, "utf8")
      )
      deployer = Keypair.fromSecretKey(Uint8Array.from(data))
    } else {
      deployer = Keypair.generate()
      log.warn(
        `no deployer keypair found, using generated: ${deployer.publicKey.toBase58()}`
      )
    }
    if (this.config.clusterDataPath != null) {
      mkdirs(this.config.clusterDataPath)
      const persistedFile = SolanaFundingTool.deployerKeypairFile(
        this.config.clusterDataPath
      )
      Fs.writeFileSync(
        persistedFile,
        JSON.stringify(Array.from(deployer.secretKey))
      )
      log.info(`persisted SOL deployer keypair to ${persistedFile}`)
    }
    return deployer
  }

  /** Derive a program-derived address from `seed` under the opp-outpost program. */
  private deriveProgramAddress(programId: PublicKey, seed: string): PublicKey {
    return SolanaOutpostProgramTool.derivePda(programId, Buffer.from(seed))
  }

  /** Derive a `(token_code, reserve_code)`-scoped PDA (reserve / reserve_vault). */
  private deriveReserveScopedAddress(
    programId: PublicKey,
    seed: string,
    tokenCode: number,
    reserveCode: number
  ): PublicKey {
    return SolanaOutpostProgramTool.derivePda(
      programId,
      Buffer.from(seed),
      slugNameToLittleEndianBuffer(tokenCode),
      slugNameToLittleEndianBuffer(reserveCode)
    )
  }

  private async initializePDAs(deployer: Keypair): Promise<void> {
    const programId = this.programId
    Assert.ok(programId != null, "initializePDAs: programId required")
    log.info("initializing OPP outpost PDAs...")

    const configPda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OutpostConfig
    )
    const outboundMessageBufferPda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OutboundMessageBuffer
    )
    const operatorRegistryPda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OperatorRegistry
    )
    const inboundEnvelopesPda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.InboundEnvelopes
    )
    const outboundEnvelopesPda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OutboundEnvelopes
    )
    const latestOutboundEnvelopePda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.LatestOutboundEnvelope
    )

    log.info(`  config:                 ${configPda.toBase58()}`)
    log.info(`  outboundMessageBuffer:  ${outboundMessageBufferPda.toBase58()}`)
    log.info(`  operatorRegistry:       ${operatorRegistryPda.toBase58()}`)
    log.info(`  inboundEnvelopes:       ${inboundEnvelopesPda.toBase58()}`)
    log.info(`  outboundEnvelopes:      ${outboundEnvelopesPda.toBase58()}`)
    log.info(
      `  latestOutboundEnvelope: ${latestOutboundEnvelopePda.toBase58()}`
    )

    const configAccount = await this.connection.getAccountInfo(configPda)
    if (configAccount != null && configAccount.data.length > 0) {
      log.info("PDAs already initialized, skipping")
      return
    }

    // The ONE existence check on this path: a missing IDL is not fatal HERE —
    // the PDAs are simply left uninitialized (a program that was never built
    // has nothing to initialize against). Every other caller takes the
    // throwing contract of `SolanaOutpostProgramTool.loadProgram`.
    const idlFile = SolanaOutpostProgramTool.programIdlFile(
      this.config.solanaPath
    )
    if (!Fs.existsSync(idlFile)) {
      log.warn(`IDL not found at ${idlFile} — skipping PDA initialization`)
      return
    }
    const program = this.loadProgram(deployer)

    // The OPP admin ops are gated by the liqsol `global_config`
    // (`has_one = admin`), which must be initialized once before the outpost.
    await this.ensureGlobalConfig(deployer, program)

    // `initialize_outpost` takes only the outpost's `chain_code`
    // (SOL ⇒ "SOLANA"_c) — consensus thresholds are derived on-the-fly per
    // `epoch_in` and the epoch duration is propagated via the
    // BATCH_OPERATOR_GROUPS attestation. (The clean-room rename: liqsol_core's
    // own staking `initialize` already claims the bare name.)
    const solanaChainCode = new anchor.BN(
      SlugName.from(SolanaOutpostBootstrapper.SolanaChainCodename)
    )
    const initializeTransaction = await program.methods
      .initializeOutpost(solanaChainCode)
      .accounts({
        ...this.getAdminAccounts(deployer),
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
    await this.runSimpleAuthorityInstruction(
      deployer,
      initializeTransaction,
      "initialize_outpost"
    )
    log.info("PDAs initialized successfully")

    // Register the native-SOL binding (mint = all-zeroes `PublicKey.default`)
    // so `deposit(SOL_CODE, ...)` doesn't revert with `TokenCodeNotConfigured`.
    const solTokenCode = new anchor.BN(
      SlugName.from(SolanaOutpostBootstrapper.SolTokenCodename)
    )
    const setTokenAddressTransaction = await program.methods
      .setTokenAddress(solTokenCode, anchor.web3.PublicKey.default)
      .accounts({ ...this.getAdminAccounts(deployer), config: configPda })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(
      deployer,
      setTokenAddressTransaction,
      "set_token_address"
    )
    log.info("SOL native-token binding registered")

    // Precision is REQUIRED for every registered token — the program's
    // `PrecisionUnconfigured` gate and wire-ethereum's
    // `WIRE_TokenPrecisionUnset` are the same contract (no silent defaults).
    // Bind native SOL's 9 (lamports) right after its address binding so
    // `create_reserve_native` and every SOL swap path can frame-convert.
    const setSolPrecisionTransaction = await program.methods
      .setTokenPrecision(
        solTokenCode,
        SolanaOutpostBootstrapper.SolTokenDecimals
      )
      .accounts({ ...this.getAdminAccounts(deployer), config: configPda })
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
    const reserveAggregatePda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.ReserveAggregate
    )
    log.info(`  reserveAggregate:       ${reserveAggregatePda.toBase58()}`)
    const initReserveTransaction = await program.methods
      .initReserve()
      .accounts({
        payer: deployer.publicKey,
        ...this.getAdminAccounts(deployer),
        config: configPda,
        reserveAggregate: reserveAggregatePda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(
      deployer,
      initReserveTransaction,
      "init_reserve"
    )
    log.info("SOL ReserveAggregate PDA initialized")

    // Bootstrap-seeded native SOL reserve — the outpost-side mirror of the
    // depot's SOLANA/SOL/PRIMARY row. `create_reserve_native` is the
    // authority-gated, NATIVE-only bootstrap-symmetry IX (no SPL Mint/ATA, no
    // RESERVE_CREATE attestation; status=Active set inline).
    const solReserveCode = new anchor.BN(
      SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename)
    )
    const nativeReserveAmount = new anchor.BN(
      SolanaOutpostBootstrapper.BootstrapNativeReserveLamports
    )
    const solReservePda = this.deriveReserveScopedAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.Reserve,
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
        ...this.getAdminAccounts(deployer),
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
    Assert.ok(
      clusterDataPath != null,
      "provisionSplReserves: clusterDataPath required"
    )
    Assert.ok(programId != null, "provisionSplReserves: programId required")
    log.info(
      "[solana] provisioning mock SPL reserves (USDCSOL, USDTSOL, LIQSOL)..."
    )

    const primaryCode = new anchor.BN(
      SlugName.from(SolanaOutpostBootstrapper.PrimaryReserveCodename)
    )
    const persisted: SolanaOutpostBootstrapper.PersistedSplMint[] = []

    // Every registered SPL mint can back a CollateralPosition, and an
    // OPERATOR_ACTION(SLASH) settles that custody into the reserve_aggregate's
    // canonical ATA (opp/inbound.rs `process_slash_action` SPL branch). The
    // program never creates ATAs, so a missing one makes the slash log-and-skip
    // — silently dropping the seizure, which carries no return attestation to
    // re-drive it. Pre-create the aggregate ATA per mint here so every SPL slash
    // has a live destination (SOL-380).
    const reserveAggregatePda = this.deriveProgramAddress(
      programId,
      SolanaOutpostBootstrapper.PdaSeed.ReserveAggregate
    )

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
        log.info(
          `[solana]    deployer ATA funded (ata=${deployerAta.toBase58()})`
        )

        const setAddressTransaction = await program.methods
          .setTokenAddress(codeBigNumber, mint)
          .accounts({ ...this.getAdminAccounts(deployer), config: configPda })
          .signers([deployer])
          .transaction()
        await this.runSimpleAuthorityInstruction(
          deployer,
          setAddressTransaction,
          `set_token_address(${specification.codeName})`
        )

        const setPrecisionTransaction = await program.methods
          .setTokenPrecision(codeBigNumber, specification.decimals)
          .accounts({ ...this.getAdminAccounts(deployer), config: configPda })
          .signers([deployer])
          .transaction()
        await this.runSimpleAuthorityInstruction(
          deployer,
          setPrecisionTransaction,
          `set_token_precision(${specification.codeName})`
        )

        // reserve_aggregate is a PDA (off-curve owner) — the SPL slash destination.
        const aggregateAta =
          await SolanaFundingTool.ensureAssociatedTokenAccount(
            this.connection,
            deployer,
            mint,
            reserveAggregatePda,
            true
          )
        log.info(
          `[solana]    reserve_aggregate ATA ensured (ata=${aggregateAta.toBase58()})`
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
            ...this.getAdminAccounts(deployer),
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

        persisted.push({
          code,
          mint: mint.toBase58(),
          decimals: specification.decimals
        })
        log.info(
          `[solana]    reserve PDA seeded (${specification.codeName}/PRIMARY)`
        )
      }
    )

    mkdirs(clusterDataPath)
    const persistedFile = Path.join(clusterDataPath, "sol-mock-mints.json")
    Fs.writeFileSync(persistedFile, JSON.stringify(persisted, null, 2))
    log.info(
      `[solana] persisted ${persisted.length} mock SPL mint(s) to ${persistedFile}`
    )
  }

  /**
   * The signer/authority accounts every OPP admin instruction shares: the
   * liqsol program takes `admin` + the gating `global_config` PDA
   * (`has_one = admin`).
   *
   * @param deployer - the deployer keypair (the outpost `admin`).
   * @return the account fragment to spread into an admin instruction's `.accounts`.
   */
  private getAdminAccounts(
    deployer: Keypair
  ): SolanaOutpostBootstrapper.AdminAccounts {
    Assert.ok(
      this.globalConfigPda != null,
      "getAdminAccounts: global_config not initialized"
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
      [Buffer.from(SolanaOutpostBootstrapper.PdaSeed.GlobalConfig)],
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
      SolanaOutpostBootstrapper.BpfLoaderUpgradeableProgramId
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
    await this.runSimpleAuthorityInstruction(
      deployer,
      transaction,
      "initialize_global_config"
    )
    log.info(
      `liqsol global_config initialized (admin=${deployer.publicKey.toBase58()})`
    )
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
    const signature = await this.connection.sendTransaction(
      transaction,
      [signer],
      {
        skipPreflight: false
      }
    )
    await confirmSignature(this.connection, signature, label)
  }

  /** The OPP outpost Anchor `Program` bound to `deployer` on this bootstrapper's connection. */
  private loadProgram(deployer: Keypair): anchor.Program<anchor.Idl> {
    return SolanaOutpostProgramTool.loadProgram(
      this.connection,
      deployer,
      this.config.solanaPath
    )
  }

  /**
   * Seed the SOL outpost's first operator roster + signable group via
   * `opp_bootstrap` (SOL-376). The outpost starts with `registry_initialized =
   * false` and `epoch_in` refuses to finalize until this runs, so it must
   * happen AFTER the depot materializes its epoch-1 batch-operator group and
   * BEFORE the depot delivers its first envelope. The seed is transient — the
   * depot's first `BatchOperatorGroups` attestation overwrites it under
   * consensus.
   *
   * @param seed - the epoch-1 group's roster + its SOL pubkeys. Both halves are
   *   GROUP-bounded and must stay paired: the roster is exactly the group's
   *   operators (the program needs one signable group, and Anchor borsh-encodes
   *   the instruction into a fixed
   *   {@link SolanaOutpostBootstrapper.AnchorInstructionBufferBytes}-byte buffer
   *   a larger seed overruns), and the group's SIZE drives the outpost's
   *   consensus threshold (`consensus_reached_now`), so seeding more than the
   *   delivering set would stall epoch 1.
   * @param epochDurationSec - the depot's epoch duration (must be positive).
   */
  async oppBootstrap(
    seed: SolanaOutpostBootstrapper.OppBootstrapSeed,
    epochDurationSec: number
  ): Promise<void> {
    const { operators, groupMembers } = seed
    Assert.ok(operators.length > 0, "oppBootstrap: at least one operator is required")
    Assert.ok(groupMembers.length > 0, "oppBootstrap: at least one group member is required")
    Assert.ok(epochDurationSec > 0, "oppBootstrap: epochDurationSec must be positive")
    Assert.ok(
      SolanaOutpostBootstrapper.oppBootstrapEncodedBytes(
        operators.length,
        groupMembers.length
      ) <= SolanaOutpostBootstrapper.AnchorInstructionBufferBytes,
      `oppBootstrap: a group of ${groupMembers.length} exceeds the ` +
        `${SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers}-member limit — Anchor encodes ` +
        `the instruction into a fixed ${SolanaOutpostBootstrapper.AnchorInstructionBufferBytes}-byte ` +
        `buffer and the roster and group BOTH scale with the group size`
    )

    const { solanaPath } = this.config,
      programId = SolanaOutpostProgramTool.assertProgramId(solanaPath),
      idlFile = SolanaOutpostProgramTool.programIdlFile(solanaPath)
    this.programId = programId

    const deployer = this.loadOrGenerateDeployer()
    const program = this.loadProgram(deployer)
    // The IDL predates SOL-376 when `opp_bootstrap` is absent; without this the
    // call dies as a bare `program.methods.oppBootstrap is not a function`.
    Assert.ok(
      typeof program.methods.oppBootstrap === "function",
      `oppBootstrap: the ${SolanaOutpostProgramTool.ProgramName} IDL at ${idlFile} has no ` +
        `opp_bootstrap instruction — rebuild wire-solana at SOL-376 or newer ` +
        `${SolanaOutpostProgramTool.BuildRemediationHint}`
    )
    // `opp_bootstrap` is `has_one = admin`-gated on the same liqsol
    // `global_config` every OPP admin op uses — idempotent when already set.
    await this.ensureGlobalConfig(deployer, program)

    const Seed = SolanaOutpostBootstrapper.PdaSeed,
      configPda = this.deriveProgramAddress(programId, Seed.OutpostConfig),
      operatorRegistryPda = this.deriveProgramAddress(programId, Seed.OperatorRegistry)

    log.info(
      `opp_bootstrap: seeding ${operators.length} operator(s), group of ${groupMembers.length}, epoch_duration=${epochDurationSec}s`
    )
    const transaction = await program.methods
      .oppBootstrap(operators, groupMembers, epochDurationSec)
      .accounts({
        ...this.getAdminAccounts(deployer),
        config: configPda,
        operatorRegistry: operatorRegistryPda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    await this.runSimpleAuthorityInstruction(deployer, transaction, "opp_bootstrap")
    log.info("opp_bootstrap: SOL outpost roster seeded — registry_initialized")
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
    /**
     * Per-`(operator, token_code)` bonded-collateral position. BOTH deposit
     * instructions declare it `init_if_needed, payer = depositor`, so it is
     * supplied on every deposit — opened on the first, and auto-closed
     * (refunding rent) when the balance reaches zero.
     */
    export const CollateralPosition = "collateral_position"
    /** Per-`token_code` SPL collateral vault — from `deposit_non_native.rs`. */
    export const CollateralVault = "collateral_vault"
    /**
     * liqsol `GlobalConfig` admin-gate PDA (`has_one = admin`) — from
     * `states/global_config.rs`'s `GlobalConfig::SEEDS`, shared with the
     * staking surface.
     */
    export const GlobalConfig = "global_config"
  }

  /**
   * BPF upgradeable-loader program id — owner of every upgradeable program's
   * `ProgramData` account, from which `initialize_global_config` proves the
   * caller is the program's on-chain upgrade authority.
   */
  export const BpfLoaderUpgradeableProgramId = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  )

  /**
   * The shared signer/gating accounts every OPP admin instruction takes: the
   * liqsol program's `admin` + the `global_config` PDA it checks `has_one`
   * against. Spread into an admin instruction's `.accounts({ ... })`.
   */
  export interface AdminAccounts {
    /** The outpost admin (== the deployer / program upgrade authority). */
    admin: PublicKey
    /** The gating `global_config` PDA (`has_one = admin`). */
    globalConfig: PublicKey
  }

  /**
   * One genesis operator seeded into the SOL outpost registry via
   * {@link SolanaOutpostBootstrapper.oppBootstrap} (SOL-376). Mirrors the
   * program's `BootstrapOperator` struct (`wire_name`/`sol_address`/`role`/
   * `status`).
   */
  export interface BootstrapOperator {
    /** Antelope-encoded WIRE account name (`u64`, via `Name.value`). */
    wireName: anchor.BN
    /** The operator's Solana native pubkey. */
    solAddress: PublicKey
    /** Operator role — the proto `OperatorType` numeric value. */
    role: OperatorType
    /** Operator status — must be `OperatorStatus.ACTIVE` for a group member. */
    status: OperatorStatus
  }

  /**
   * The `opp_bootstrap` seed passed to
   * {@link SolanaOutpostBootstrapper.oppBootstrap}: the epoch-1 group's
   * operators and their SOL pubkeys. The two halves are the SAME set — see
   * {@link operators} for why the roster stays group-bounded.
   */
  export interface OppBootstrapSeed {
    /**
     * The epoch-1 group's operators — the minimal signable seed roster,
     * deliberately NOT every provisioned batch operator: the program only needs
     * one signable group (the depot's first envelope installs the authoritative
     * roster under consensus), and the whole payload must fit
     * {@link AnchorInstructionBufferBytes}.
     */
    operators: BootstrapOperator[]
    /** The SOL pubkeys of exactly the depot's epoch-1 batch-operator group. */
    groupMembers: PublicKey[]
  }

  /**
   * Anchor 0.31's fixed borsh instruction-encode buffer (`Buffer.alloc(1000)` in
   * its `BorshInstructionCoder`). Raising it is not ours to do — it is the
   * dependency's constant; the seed is sized to fit it.
   */
  export const AnchorInstructionBufferBytes = 1_000
  /** Borsh size of one {@link BootstrapOperator} roster entry (u64 + 32-byte pubkey + two u32). */
  export const OppBootstrapRosterEntryBytes = 48
  /** Borsh size of one group-member `Pubkey`. */
  export const OppBootstrapGroupMemberBytes = 32
  /**
   * Fixed `opp_bootstrap` payload overhead INSIDE the encode buffer: the two
   * 4-byte vec lengths and the 4-byte epoch duration. The 8-byte instruction
   * discriminator is deliberately NOT counted — Anchor concatenates it AFTER
   * slicing the buffer (`Buffer.concat([discriminator, data])`), so it never
   * occupies the 1000 bytes this budget is measured against.
   */
  export const OppBootstrapFixedPayloadBytes = 12
  /**
   * Largest group `opp_bootstrap` can encode. Because the roster IS the group
   * ({@link OppBootstrapSeed}), every member costs a roster entry AND a pubkey,
   * so the buffer caps the GROUP size — never the cluster topology.
   *
   * NOTE: this is the ENCODE-buffer ceiling, not the tightest one. A legacy
   * transaction packet is capped at 1232 bytes, and this instruction ships with
   * ~270 bytes of envelope, which bounds the group at 11. That never bites
   * today because {@link BatchOperatorSchedule} rejects an even group size, so
   * the reachable sizes straddling both limits are 11 (fits) and 13 (rejected
   * here). Re-derive both if odd-only group sizing is ever relaxed.
   */
  export const MaxOppBootstrapGroupMembers = Math.floor(
    (AnchorInstructionBufferBytes - OppBootstrapFixedPayloadBytes) /
      (OppBootstrapRosterEntryBytes + OppBootstrapGroupMemberBytes)
  )

  /**
   * Borsh-encoded size of an `opp_bootstrap` instruction payload.
   *
   * @param operatorCount - roster length.
   * @param groupMemberCount - group length.
   * @returns The encoded byte count, to compare against {@link AnchorInstructionBufferBytes}.
   */
  export function oppBootstrapEncodedBytes(
    operatorCount: number,
    groupMemberCount: number
  ): number {
    return (
      OppBootstrapFixedPayloadBytes +
      OppBootstrapRosterEntryBytes * operatorCount +
      OppBootstrapGroupMemberBytes * groupMemberCount
    )
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
  export const SplReserveSpecifications: ReadonlyArray<SplReserveSpecification> =
    [
      {
        codeName: "USDCSOL",
        decimals: 6,
        chainAmount: 1_000_000n * 1_000_000n
      },
      {
        codeName: "USDTSOL",
        decimals: 6,
        chainAmount: 1_000_000n * 1_000_000n
      },
      { codeName: "LIQSOL", decimals: 9, chainAmount: 20n * 1_000_000_000n }
    ]

  /** Default deployer keypair file (`~/.config/solana/id.json`). */
  export function defaultDeployerKeypairFile(): string {
    return Path.join(process.env.HOME || "~", ".config", "solana", "id.json")
  }
}
