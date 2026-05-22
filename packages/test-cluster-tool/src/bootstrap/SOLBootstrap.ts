import Assert from "node:assert"
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL
} from "@solana/web3.js"
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import * as anchor from "@coral-xyz/anchor"
import Path from "path"
import Fs from "fs"
import { SlugName } from "@wireio/sdk-core"

import { SOLClient } from "../clients/SOLClient.js"
import { log } from "../logger.js"
import { retry, sleep } from "../util.js"
import { createMockSplMint, mintMockSplToUser } from "../tools/SplFundingTool.js"

/** Total attempts allowed for each Solana airdrop / RPC retry block. */
const SolAirdropRetryAttempts = 3
/** Delay between airdrop / RPC retries. */
const SolAirdropRetryDelayMs = 2_000
/** Confirmation polling interval for airdrops. */
const SolAirdropConfirmIntervalMs = 500
/** Hard deadline for an individual airdrop confirmation. */
const SolAirdropConfirmTimeoutMs = 60_000

/**
 * Lamports to fund the bootstrap-seeded native SOL Reserve PDA with.
 * Sized to cover several swap-with-underwriting test runs (each draws
 * ~0.5 SOL of source amount → ~0.5 SOL destination payout, so 20 SOL
 * provides ~40 runs of headroom) plus the per-account rent floor.
 */
const BootstrapNativeReserveLamports = 20 * LAMPORTS_PER_SOL

/** Bancor weight in basis points for the bootstrap-seeded native reserve. */
const BootstrapConnectorWeightBps = 5000

/**
 * Encode a `number` slug_name as an 8-byte little-endian Buffer matching
 * the program's `to_le_bytes()` seed derivation.
 */
function SlugNameToLeBuffer(value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

/**
 * Solana outpost bootstrap.
 *
 * Runs against a test validator that already has the `opp_outpost` program
 * loaded (via `--bpf-program` at validator launch). Responsibilities:
 *   - Airdrop SOL to a deployer keypair
 *   - Initialize the `OutpostConfig` / `OutboundMessageBuffer` / `OperatorRegistry` PDAs
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
  /**
   * Optional directory under which mock-SPL-mint metadata is
   * persisted (file: `sol-mock-mints.json`) for downstream consumers
   * — primarily `ClusterManager`'s Phase 16 token registration, which
   * needs the SPL mint pubkeys to register the chain-side
   * `ChainToken.contract_addr` for USDC/USDT/LIQSOL on the SOL
   * side. When omitted, the SPL provisioning step is skipped (the
   * outpost still has native SOL working, but no SPL reserves).
   */
  clusterDataPath?: string
}

/**
 * Persisted mock-SPL-mint metadata written by `provisionSplReserves`
 * and consumed by `ClusterManager`'s Phase 16a/b/c token registration.
 * Each entry is a `(slug_name code, mint pubkey, decimals)` triple
 * keyed by code so callers can look up by slug_name without a map
 * dependency.
 */
export interface PersistedSplMint {
  /** Slug-name codename packed into `u64`-equivalent number. */
  code: number
  /** Base58 mint pubkey. */
  mint: string
  /** Chain-native decimals (6 for USDC/USDT, 9 for LIQSOL). */
  decimals: number
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
  async airdropAccounts(pubkeys: string[], amountSol = 100): Promise<void> {
    const lamports = amountSol * LAMPORTS_PER_SOL
    await Promise.all(
      pubkeys.map(async pk => {
        const pub = new PublicKey(pk)
        await retry(
          async () => {
            const sig = await this.connection.requestAirdrop(pub, lamports)
            const deadline = Date.now() + SolAirdropConfirmTimeoutMs
            while (Date.now() < deadline) {
              const status = await this.connection.getSignatureStatus(sig)
              const conf = status?.value?.confirmationStatus
              if (conf === "confirmed" || conf === "finalized") break
              if (status?.value?.err)
                throw new Error(
                  `Airdrop tx failed: ${JSON.stringify(status.value.err)}`
                )
              await sleep(SolAirdropConfirmIntervalMs)
            }
            if (Date.now() >= deadline)
              throw new Error(
                `Airdrop not confirmed within ${SolAirdropConfirmTimeoutMs}ms`
              )
          },
          { label: `airdrop to ${pk}`, maxAttempts: SolAirdropRetryAttempts, delayMs: SolAirdropRetryDelayMs }
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
      const keypairData = JSON.parse(
        Fs.readFileSync(programKeypairFile, "utf8")
      )
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
          if (status?.value?.err)
            throw new Error(
              `Airdrop tx failed: ${JSON.stringify(status.value.err)}`
            )
          await sleep(500)
        }
        if (Date.now() >= deadline)
          throw new Error("Airdrop not confirmed within 60s")
      },
      { label: "airdrop to deployer", maxAttempts: SolAirdropRetryAttempts, delayMs: SolAirdropRetryDelayMs }
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
    const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outbound_message_buffer")],
      this.programId!
    )
    const [operatorRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator_registry")],
      this.programId!
    )
    // Singleton envelope log PDAs — new in the durability-v2 program.
    // `epoch_in` appends to `inbound_envelopes`; `emit_outbound_envelope`
    // appends to `outbound_envelopes`. Both are created during `initialize`.
    const [inboundEnvelopesPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("inbound_envelopes")],
      this.programId!
    )
    const [outboundEnvelopesPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outbound_envelopes")],
      this.programId!
    )
    const [latestOutboundEnvelopePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("latest_outbound_envelope")],
      this.programId!
    )

    log.info(`  Config PDA:                   ${configPda.toBase58()}`)
    log.info(`  OutMsgBuffer PDA:             ${outboundMessageBufferPda.toBase58()}`)
    log.info(`  Registry PDA:                 ${operatorRegistryPda.toBase58()}`)
    log.info(`  InboundEnvelopes PDA:         ${inboundEnvelopesPda.toBase58()}`)
    log.info(`  OutboundEnvelopes PDA:        ${outboundEnvelopesPda.toBase58()}`)
    log.info(`  LatestOutboundEnvelope PDA:   ${latestOutboundEnvelopePda.toBase58()}`)

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

    // Build tx and send+confirm via HTTP polling. Anchor's .rpc() uses the
    // deprecated confirmTransaction (30s wall-clock) which fails here because
    // the Solana WebSocket port (rpcPort+1) is occupied by another service.
    // `initialize` no longer takes a consensus threshold — both consensus
    // thresholds (primary = group_size, fallback = ceil(group_size / 2)) are
    // derived on-the-fly from `OperatorRegistry.groups[0].members.len()` at
    // each `epoch_in` call, and `epoch_duration_sec` is propagated via the
    // `BATCH_OPERATOR_GROUPS` attestation. See .claude/rules/opp-consensus.md.
    //
    // `chain_code` (v6 data-model refactor) — the outpost's slug_name on
    // the WIRE depot's chain registry, stamped onto every outbound
    // attestation. SOL outpost ⇒ `"SOLANA"_c`.
    const solanaChainCode = new anchor.BN(SlugName.from("SOLANA"))
    const tx = await program.methods
      .initialize(solanaChainCode)
      .accounts({
        authority: deployer.publicKey,
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

    const initSig = await this.connection.sendTransaction(tx, [deployer], {
      skipPreflight: false
    })

    const initDeadline = Date.now() + 60_000
    while (Date.now() < initDeadline) {
      const status = await this.connection.getSignatureStatus(initSig)
      const conf = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") break
      if (status?.value?.err)
        throw new Error(
          `Initialize tx failed: ${JSON.stringify(status.value.err)}`
        )
      await sleep(500)
    }
    if (Date.now() >= initDeadline)
      throw new Error("Initialize not confirmed within 60s")

    log.info("PDAs initialized successfully")

    // Register the native-SOL binding so the outpost will accept native
    // deposits. Per the proto rule `ChainToken.is_native ⇒ empty
    // contract_addr`, "native" on the outpost is the entry whose mint
    // is the all-zeroes Pubkey (`NATIVE_TOKEN_MARKER`). Without this
    // entry, `deposit(SOL_CODE, ...)` reverts with
    // `TokenCodeNotConfigured` because the per-code lookup is empty.
    const solTokenCode = new anchor.BN(SlugName.from("SOL"))
    const setTokenAddrTx = await program.methods
      .setTokenAddress(solTokenCode, anchor.web3.PublicKey.default)
      .accounts({
        authority: deployer.publicKey,
        config:    configPda
      })
      .signers([deployer])
      .transaction()
    const setSig = await this.connection.sendTransaction(
      setTokenAddrTx,
      [deployer],
      { skipPreflight: false }
    )
    const setDeadline = Date.now() + 60_000
    while (Date.now() < setDeadline) {
      const status = await this.connection.getSignatureStatus(setSig)
      const conf = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") break
      if (status?.value?.err)
        throw new Error(
          `set_token_address tx failed: ${JSON.stringify(status.value.err)}`
        )
      await sleep(500)
    }
    if (Date.now() >= setDeadline)
      throw new Error("set_token_address not confirmed within 60s")

    log.info("SOL native-token binding registered")

    // Initialize the ReserveAggregate PDA (seeded with `reserve_aggregate`).
    // The `epoch_in` ix declares this account as a writable Anchor
    // `Account<ReserveAggregate>`, so without `init_reserve` running first
    // every inbound delivery from the batch operators fails with an
    // assert-exception at the simulation boundary (PDA doesn't exist).
    const [reserveAggregatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_aggregate")],
      this.programId!
    )
    log.info(`  ReserveAggregate PDA:         ${reserveAggregatePda.toBase58()}`)
    const initReserveTx = await program.methods
      .initReserve()
      .accounts({
        payer:            deployer.publicKey,
        authority:        deployer.publicKey,
        config:           configPda,
        reserveAggregate: reserveAggregatePda,
        systemProgram:    anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    const initReserveSig = await this.connection.sendTransaction(
      initReserveTx,
      [deployer],
      { skipPreflight: false }
    )
    const initReserveDeadline = Date.now() + 60_000
    while (Date.now() < initReserveDeadline) {
      const status = await this.connection.getSignatureStatus(initReserveSig)
      const conf = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") break
      if (status?.value?.err)
        throw new Error(
          `init_reserve tx failed: ${JSON.stringify(status.value.err)}`
        )
      await sleep(500)
    }
    if (Date.now() >= initReserveDeadline)
      throw new Error("init_reserve not confirmed within 60s")

    log.info("SOL ReserveAggregate PDA initialized")

    // Bootstrap-seeded native SOL reserve.
    //
    // The depot's `sysio.reserv::regreserve` (run in `ClusterManager`
    // Phase 16c) creates the depot-side accounting row for
    // SOLANA/SOL/PRIMARY with status=ACTIVE. The outpost-side mirror is
    // the per-(token_code, reserve_code) Reserve PDA — without it
    // `handle_swap_remit` can't find the lamport escrow when a
    // depot-authorized SwapRemit arrives, and `request_swap` reverts
    // on the `seeds = [RESERVE_SEED, ...]` constraint.
    //
    // `create_reserve_native` is the authority-gated, NATIVE-only
    // bootstrap-symmetry IX (no SPL Mint/ATA required, no
    // RESERVE_CREATE attestation emitted — depot row already exists,
    // status=Active set inline).
    const solReserveCode = new anchor.BN(SlugName.from("PRIMARY"))
    const initialChainAmount = new anchor.BN(BootstrapNativeReserveLamports)
    const initialWireAmount  = new anchor.BN(BootstrapNativeReserveLamports)
    const [solReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("reserve"),
        SlugNameToLeBuffer(SlugName.from("SOL")),
        SlugNameToLeBuffer(SlugName.from("PRIMARY"))
      ],
      this.programId!
    )
    log.info(`  Reserve PDA (SOL/PRIMARY):    ${solReservePda.toBase58()}`)
    const createReserveTx = await program.methods
      .createReserveNative(
        solTokenCode,
        solReserveCode,
        initialChainAmount,
        initialWireAmount,
        BootstrapConnectorWeightBps,
        "SOLANA-SOL/WIRE primary reserve",
        "Bootstrap-seeded native SOL ↔ WIRE reserve (outpost-side custody)"
      )
      .accounts({
        payer:         deployer.publicKey,
        authority:     deployer.publicKey,
        config:        configPda,
        reserve:       solReservePda,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([deployer])
      .transaction()
    const createReserveSig = await this.connection.sendTransaction(
      createReserveTx,
      [deployer],
      { skipPreflight: false }
    )
    const createReserveDeadline = Date.now() + 60_000
    while (Date.now() < createReserveDeadline) {
      const status = await this.connection.getSignatureStatus(createReserveSig)
      const conf = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") break
      if (status?.value?.err)
        throw new Error(
          `create_reserve_native tx failed: ${JSON.stringify(status.value.err)}`
        )
      await sleep(500)
    }
    if (Date.now() >= createReserveDeadline)
      throw new Error("create_reserve_native not confirmed within 60s")

    log.info(
      `SOL native reserve seeded (PDA=${solReservePda.toBase58()}, lamports=${BootstrapNativeReserveLamports})`
    )

    // Provision mock SPL reserves (USDC, USDT, LIQSOL) for flow-swap-
    // non-native-tokens. Skipped if no clusterDataPath was provided
    // (e.g. unit-test invocations of the bootstrap).
    if (this.config.clusterDataPath) {
      await this.provisionSplReserves(deployer, program, configPda)
    }
  }

  /**
   * Bootstrap mock SPL reserves on the SOL outpost. Creates SPL mints
   * for USDC + USDT + LIQSOL, binds each via `set_token_address` +
   * `set_token_precision`, then calls `create_reserve_spl_authority`
   * to allocate per-reserve token vaults seeded with bootstrap
   * liquidity. Persists the resulting mint pubkeys to
   * `<clusterDataPath>/sol-mock-mints.json` for `ClusterManager`'s
   * Phase 16 token registration.
   *
   * Treats LIQSOL as just another SPL mock per the
   * `outpost-three-concerns.md` rule that the outpost views LIQ
   * tokens as ordinary SPL custody assets (no burn/mint integration).
   * Production deployments would instead bind LIQSOL to the canonical
   * `liqsol-token` mint pubkey via `set_token_address`.
   */
  private async provisionSplReserves(
    deployer: Keypair,
    program:  anchor.Program<anchor.Idl>,
    configPda: PublicKey
  ): Promise<void> {
    Assert.ok(this.config.clusterDataPath,
      "SOLBootstrap.provisionSplReserves: clusterDataPath required")
    const programId = this.programId!
    log.info("[SOL bootstrap] Provisioning mock SPL reserves (USDC, USDT, LIQSOL)...")

    // Spec: (code, decimals, bootstrap chain-side amount in chain units)
    // USDC/USDT use 6 decimals (mainnet parity), LIQSOL uses 9 (depot parity).
    // Bootstrap amounts are sized to clear the `swap_quote` floor plus
    // a generous headroom for ~40 flow-test runs each.
    const specs: { codeName: string; decimals: number; chainAmount: bigint }[] = [
      { codeName: "USDC",   decimals: 6, chainAmount: 1_000_000n * 1_000_000n }, // 1M USDC
      { codeName: "USDT",   decimals: 6, chainAmount: 1_000_000n * 1_000_000n }, // 1M USDT
      { codeName: "LIQSOL", decimals: 9, chainAmount: 20n * 1_000_000_000n },    // 20 LIQSOL
    ]
    const primaryCode = new anchor.BN(SlugName.from("PRIMARY"))
    const persisted: PersistedSplMint[] = []

    // Sequentially: create mint → fund deployer ATA → register on outpost →
    // seed Reserve PDA. Each step is dependent on the previous one
    // landing on-chain, so Bluebird.each-style ordering is required.
    for (const spec of specs) {
      const code   = SlugName.from(spec.codeName)
      const codeBN = new anchor.BN(code)
      log.info(`[SOL bootstrap]  - Creating mock SPL mint for ${spec.codeName} (decimals=${spec.decimals})`)
      const mint = await createMockSplMint(this.connection, deployer, spec.decimals)
      log.info(`[SOL bootstrap]    mint=${mint.toBase58()}`)

      // Mint chain-amount + margin to deployer's ATA so the
      // create_reserve_spl_authority transfer succeeds.
      const deployerAta = await mintMockSplToUser(
        this.connection, deployer, mint, deployer.publicKey, spec.chainAmount * 2n
      )
      log.info(`[SOL bootstrap]    deployer ATA funded (ata=${deployerAta.toBase58()})`)

      // set_token_address — bind the slug_name code to the SPL mint.
      const setAddrTx = await program.methods
        .setTokenAddress(codeBN, mint)
        .accounts({ authority: deployer.publicKey, config: configPda })
        .signers([deployer])
        .transaction()
      await this.runSimpleAuthorityIx(
        deployer, setAddrTx, `set_token_address(${spec.codeName})`
      )

      // set_token_precision — record chain-native decimals.
      const setPrecTx = await program.methods
        .setTokenPrecision(codeBN, spec.decimals)
        .accounts({ authority: deployer.publicKey, config: configPda })
        .signers([deployer])
        .transaction()
      await this.runSimpleAuthorityIx(
        deployer, setPrecTx, `set_token_precision(${spec.codeName})`
      )

      // create_reserve_spl_authority — allocate Reserve PDA + vault,
      // transfer initial amount, status=Active inline.
      const [reservePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve"), SlugNameToLeBuffer(code), SlugNameToLeBuffer(SlugName.from("PRIMARY"))],
        programId
      )
      const [reserveVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve_vault"), SlugNameToLeBuffer(code), SlugNameToLeBuffer(SlugName.from("PRIMARY"))],
        programId
      )

      const createTx = await program.methods
        .createReserveSplAuthority(
          codeBN,
          primaryCode,
          new anchor.BN(spec.chainAmount.toString()),
          new anchor.BN(spec.chainAmount.toString()),
          BootstrapConnectorWeightBps,
          `SOLANA-${spec.codeName}/WIRE primary reserve`,
          `Bootstrap-seeded mock ${spec.codeName} ↔ WIRE reserve (outpost-side custody)`
        )
        .accounts({
          payer:          deployer.publicKey,
          authority:      deployer.publicKey,
          config:         configPda,
          reserve:        reservePda,
          reserveVault:   reserveVaultPda,
          mint,
          authorityAta:   deployerAta,
          tokenProgram:   TOKEN_PROGRAM_ID,
          systemProgram:  anchor.web3.SystemProgram.programId,
          rent:           anchor.web3.SYSVAR_RENT_PUBKEY
        })
        .signers([deployer])
        .transaction()
      await this.runSimpleAuthorityIx(
        deployer, createTx, `create_reserve_spl_authority(${spec.codeName}/PRIMARY)`
      )

      persisted.push({ code, mint: mint.toBase58(), decimals: spec.decimals })
      log.info(`[SOL bootstrap]    Reserve PDA seeded (${spec.codeName}/PRIMARY)`)
    }

    // Persist for ClusterManager's Phase 16 to pick up.
    const persistDir  = this.config.clusterDataPath!
    const persistFile = Path.join(persistDir, "sol-mock-mints.json")
    Fs.mkdirSync(persistDir, { recursive: true })
    Fs.writeFileSync(persistFile, JSON.stringify(persisted, null, 2))
    log.info(`[SOL bootstrap] Persisted ${persisted.length} mock SPL mint(s) to ${persistFile}`)
  }

  /**
   * Submit a pre-built transaction signed by `signer`, poll
   * `getSignatureStatus` until `confirmed`/`finalized`, and throw on
   * timeout. Shared between `set_token_address`, `set_token_precision`,
   * and `create_reserve_spl_authority` to keep `provisionSplReserves`
   * focused on the orchestration shape rather than the polling
   * boilerplate.
   */
  private async runSimpleAuthorityIx(
    signer: Keypair,
    tx:     anchor.web3.Transaction,
    label:  string
  ): Promise<void> {
    const sig = await this.connection.sendTransaction(tx, [signer], { skipPreflight: false })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const status = await this.connection.getSignatureStatus(sig)
      const conf   = status?.value?.confirmationStatus
      if (conf === "confirmed" || conf === "finalized") return
      if (status?.value?.err) {
        throw new Error(`${label} tx failed: ${JSON.stringify(status.value.err)}`)
      }
      await sleep(500)
    }
    throw new Error(`${label} not confirmed within 60s`)
  }
}
