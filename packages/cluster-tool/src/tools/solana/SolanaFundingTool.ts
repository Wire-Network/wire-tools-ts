import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction
} from "@solana/web3.js"
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { solanaKeypair } from "../../utils/keyPairUtils.js"
import { Report } from "../../report/Report.js"
import { getLogger } from "../../logging/Logger.js"

const log = getLogger(__filename)

/**
 * Test-cluster helpers for creating mock SPL mints and funding wallets with
 * token balances on the local Solana validator. Mints are created with manual
 * `SystemProgram.createAccount` + `createInitializeMint2Instruction` (not
 * `@solana/spl-token`'s `createMint`, which relies on a WebSocket subscription
 * for confirmation the test validator doesn't reliably serve) and confirmed via
 * the polling {@link confirmSignature}.
 *
 * Recipient ATAs for swap *destinations* are NOT pre-created — the on-chain
 * `handle_swap_remit` SPL branch creates them on demand with the Reserve PDA as
 * rent payer.
 */
export namespace SolanaFundingTool {
  /** Minimum SPL mint decimal scale. */
  export const MinDecimals = 0
  /** Maximum SPL mint decimal scale. */
  export const MaxDecimals = 18

  /**
   * Create a new SPL mint with `mintAuthority = funder.publicKey` and no freeze
   * authority (the mock USDC / USDT / LIQSOL mints `SolanaOutpostBootstrapper`
   * provisions).
   *
   * @param connection - RPC connection to the test validator.
   * @param funder - Keypair paying rent + holding mint authority.
   * @param decimals - Mint decimal scale (6 for USDC/USDT, 9 for SOL parity).
   * @returns The new mint's public key.
   */
  export async function createMockSplMint(
    connection: Connection,
    funder: Keypair,
    decimals: number
  ): Promise<PublicKey> {
    Assert.ok(
      decimals >= MinDecimals && decimals <= MaxDecimals,
      `SolanaFundingTool: decimals must be in [${MinDecimals}, ${MaxDecimals}], got ${decimals}`
    )
    log.info(
      `[SolanaFundingTool] createMockSplMint start (decimals=${decimals})`
    )

    const mintKeypair = Keypair.generate()
    log.info(
      `[SolanaFundingTool] generated mint pubkey=${mintKeypair.publicKey.toBase58()}`
    )
    const rentLamports =
      await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: funder.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports: rentLamports,
        programId: TOKEN_PROGRAM_ID
      }),
      createInitializeMint2Instruction(
        mintKeypair.publicKey,
        decimals,
        funder.publicKey,
        null
      )
    )
    await sendAndPoll(
      connection,
      transaction,
      [funder, mintKeypair],
      "createMockSplMint"
    )
    log.info(
      `[SolanaFundingTool] mint created (${mintKeypair.publicKey.toBase58()})`
    )
    return mintKeypair.publicKey
  }

  /**
   * Credit `amount` base units of `mint` to `recipient`'s Associated Token
   * Account, creating the ATA first if absent.
   *
   * @param connection - RPC connection.
   * @param funder - Mint-authority keypair + ATA rent payer.
   * @param mint - The SPL mint pubkey (from {@link createMockSplMint}).
   * @param recipient - Recipient pubkey.
   * @param amount - Token units to mint (chain-native base units).
   * @returns The recipient's ATA pubkey.
   */
  export async function mintMockSplToUser(
    connection: Connection,
    funder: Keypair,
    mint: PublicKey,
    recipient: PublicKey,
    amount: bigint
  ): Promise<PublicKey> {
    Assert.ok(amount > 0n, "SolanaFundingTool: mint amount must be > 0")
    const { ata, createInstruction } = await resolveAssociatedTokenAccount(
      connection,
      funder,
      mint,
      recipient
    )
    // ONE transaction: the ATA creation (when needed) rides with the mint, so
    // the credit is atomic and costs a single confirmation.
    const transaction = new Transaction()
    if (createInstruction != null) transaction.add(createInstruction)
    transaction.add(
      createMintToInstruction(mint, ata, funder.publicKey, amount)
    )
    await sendAndPoll(connection, transaction, [funder], "mintMockSplToUser")
    return ata
  }

  /**
   * Ensure the Associated Token Account for `(owner, mint)` exists, creating an
   * empty one if absent. Idempotent — a present ATA no-ops. Unlike
   * {@link mintMockSplToUser} this mints nothing; it only guarantees the account
   * exists so a later SPL transfer INTO it cannot fail for want of a destination.
   *
   * `allowOwnerOffCurve` must be `true` when `owner` is a program PDA (e.g. the
   * `reserve_aggregate` custody account), whose address is off the ed25519 curve.
   *
   * @param connection - RPC connection.
   * @param funder - ATA rent payer keypair.
   * @param mint - The SPL mint pubkey.
   * @param owner - The ATA owner (a wallet, or a PDA when `allowOwnerOffCurve`).
   * @param allowOwnerOffCurve - Permit a PDA owner (default `false`).
   * @returns The owner's ATA pubkey for `mint`.
   */
  export async function ensureAssociatedTokenAccount(
    connection: Connection,
    funder: Keypair,
    mint: PublicKey,
    owner: PublicKey,
    allowOwnerOffCurve = false
  ): Promise<PublicKey> {
    const { ata, createInstruction } = await resolveAssociatedTokenAccount(
      connection,
      funder,
      mint,
      owner,
      allowOwnerOffCurve
    )
    if (createInstruction != null)
      await sendAndPoll(
        connection,
        new Transaction().add(createInstruction),
        [funder],
        "ensureAssociatedTokenAccount"
      )
    return ata
  }

  /** The ATA address plus, when it does not exist yet, the ix that creates it. */
  interface AssociatedTokenAccountPlan {
    readonly ata: PublicKey
    /** `null` when the account already exists — nothing to add to a transaction. */
    readonly createInstruction: TransactionInstruction
  }

  /**
   * Derive the `(owner, mint)` ATA and probe whether it exists — the shared
   * half of {@link ensureAssociatedTokenAccount} and {@link mintMockSplToUser}.
   *
   * Returns the creation INSTRUCTION rather than sending it, so each caller
   * keeps its own transaction shape: `mintMockSplToUser` batches it with the
   * `mintTo` in one transaction, while `ensureAssociatedTokenAccount` sends it
   * alone. Namespace-private.
   *
   * @param connection - RPC connection.
   * @param funder - ATA rent payer keypair.
   * @param mint - The SPL mint pubkey.
   * @param owner - The ATA owner (a wallet, or a PDA when `allowOwnerOffCurve`).
   * @param allowOwnerOffCurve - Permit a PDA owner (default `false`).
   * @returns The ATA, and its creation ix when the account is absent.
   */
  async function resolveAssociatedTokenAccount(
    connection: Connection,
    funder: Keypair,
    mint: PublicKey,
    owner: PublicKey,
    allowOwnerOffCurve = false
  ): Promise<AssociatedTokenAccountPlan> {
    const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve),
      ataInfo = await connection.getAccountInfo(ata)
    return {
      ata,
      createInstruction:
        ataInfo === null
          ? createAssociatedTokenAccountInstruction(
              funder.publicKey,
              ata,
              owner,
              mint
            )
          : null
    }
  }

  /** Filename prefix of every persisted per-cluster SOL keypair. */
  export const KeypairFilePrefix = "sol-"
  /** Filename suffix of every persisted per-cluster SOL keypair. */
  export const KeypairFileSuffix = "-keypair.json"
  /**
   * Handle of the per-cluster deployer keypair — the ONE identity that is the
   * wire-solana programs' upgrade authority (set at validator launch), the
   * liqsol `global_config.admin`, and the mock-SPL mint authority.
   */
  export const DeployerKeypairName = "deployer"
  /** Persisted mint-authority (deployer) keypair filename in the cluster data dir. */
  export const DeployerKeypairFilename = `${KeypairFilePrefix}${DeployerKeypairName}${KeypairFileSuffix}`

  /**
   * Absolute path to a per-cluster SOL keypair file
   * (`<dataPath>/sol-<name>-keypair.json`). Every consumer resolves the path
   * through this function so they load the SAME keypair for a given handle.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The keypair's durable handle (e.g. {@link DeployerKeypairName}).
   * @return Absolute path to the keypair JSON file.
   */
  export function keypairFile(dataPath: string, name: string): string {
    return Path.join(
      dataPath,
      `${KeypairFilePrefix}${name}${KeypairFileSuffix}`
    )
  }

  /**
   * Absolute path to the per-cluster SOL deployer keypair file
   * (`<dataPath>/{@link DeployerKeypairFilename}`).
   *
   * @param dataPath - The cluster data directory.
   * @return Absolute path to the deployer keypair JSON file.
   */
  export function deployerKeypairFile(dataPath: string): string {
    return keypairFile(dataPath, DeployerKeypairName)
  }

  /**
   * Get-or-create a per-cluster SOL keypair by handle. Generates + persists it
   * on the first call; afterwards the persisted file is read back verbatim, so
   * every caller resolves the identical identity. Idempotent.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The keypair's durable handle.
   * @return The keypair.
   */
  export function createKeypair(dataPath: string, name: string): Keypair {
    const file = keypairFile(dataPath, name)
    if (!Fs.existsSync(file)) {
      mkdirs(Path.dirname(file))
      Fs.writeFileSync(
        file,
        JSON.stringify(Array.from(Keypair.generate().secretKey))
      )
    }
    return loadKeypair(dataPath, name)
  }

  /**
   * Load a persisted per-cluster SOL keypair by handle.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The keypair's durable handle.
   * @return The keypair.
   * @throws If the keypair has not been created yet.
   */
  export function loadKeypair(dataPath: string, name: string): Keypair {
    const file = keypairFile(dataPath, name)
    Assert.ok(
      Fs.existsSync(file),
      `SolanaFundingTool: SOL keypair "${name}" not found at ${file}`
    )
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(file, "utf8")))
    )
  }

  /**
   * Get-or-create the per-cluster SOL deployer keypair. Idempotent — see
   * {@link createKeypair}.
   *
   * @param dataPath - The cluster data directory.
   * @return The deployer keypair.
   */
  export function createDeployerKeypair(dataPath: string): Keypair {
    return createKeypair(dataPath, DeployerKeypairName)
  }

  // ── Step: airdrop SOL to a persisted per-cluster keypair (write) ─────────

  /** Input for {@link planKeypairAirdrop} — top a named keypair up to a floor. */
  export interface KeypairAirdropInput extends StepInput {
    readonly kind: "SolanaFundingTool.KeypairAirdropInput"
    /** Durable handle of the persisted keypair (see {@link createKeypair}). */
    readonly keypairName: string
    /** Ensure the keypair holds at least this many lamports. */
    readonly floorLamports: bigint
  }

  /**
   * A single `requestAirdrop` that tops a persisted per-cluster keypair up to
   * `floorLamports`, get-or-creating the keypair first. Idempotent — a keypair
   * already at/above the floor no-ops. This is the operator-free counterpart of
   * {@link planAirdrop}: the deployer (which signs every `anchor run` init
   * script and every liqsol admin op) and flow-owned user wallets have no
   * `ctx.keyStore` operator identity to resolve from.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param keypairName - The keypair's durable handle.
   * @param floorLamports - The lamport floor to top up to.
   * @returns The definition step.
   */
  export function planKeypairAirdrop<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    keypairName: string,
    floorLamports: bigint
  ): ClusterBuildStep<C, KeypairAirdropInput> {
    return ClusterBuildStep.create<C, KeypairAirdropInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaFundingTool.KeypairAirdropInput",
        keypairName,
        floorLamports
      },
      runKeypairAirdrop
    )
  }

  /** Named runner — read the balance (a read), then ONE `requestAirdrop` if below floor. */
  export async function runKeypairAirdrop<C extends ClusterBuildContext>(
    ctx: C,
    input: KeypairAirdropInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { publicKey } = createKeypair(ctx.config.dataPath, input.keypairName)
    const current = BigInt(await ctx.solana.getLamports(publicKey))
    if (current >= input.floorLamports) return
    const signature = await ctx.solana.connection.requestAirdrop(
      publicKey,
      Number(input.floorLamports - current)
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `SolanaFundingTool.planKeypairAirdrop ${input.keypairName}`
    )
  }

  // ── Step: airdrop SOL to an operator keypair (write) ─────────────────────

  /** Input for {@link planAirdrop} — top an operator's SOL keypair up to a floor. */
  export interface AirdropInput extends StepInput {
    readonly kind: "SolanaFundingTool.AirdropInput"
    /**
     * Operator's durable `label` handle — its SOL keypair is resolved from
     * `ctx.keyStore` (NOT its on-chain `account`) and airdropped to.
     */
    readonly operatorLabel: string
    /** Ensure the operator's SOL keypair holds at least this many lamports. */
    readonly floorLamports: bigint
  }

  /**
   * A single `requestAirdrop` that tops the operator's SOL keypair up to
   * `floorLamports` (a SOL collateral deposit escrows lamports from the depositor,
   * so the keypair must hold the deposit amount + fee headroom before depositing).
   * Idempotent — a keypair already at/above the floor no-ops.
   */
  export function planAirdrop<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    floorLamports: bigint
  ): ClusterBuildStep<C, AirdropInput> {
    return ClusterBuildStep.create<C, AirdropInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaFundingTool.AirdropInput", operatorLabel, floorLamports },
      runAirdrop
    )
  }

  /** Named runner — read the balance (a read), then ONE `requestAirdrop` if below floor. */
  export async function runAirdrop<C extends ClusterBuildContext>(
    ctx: C,
    input: AirdropInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    const pubkey = solanaKeypair(operator.solana).publicKey
    const current = BigInt(await ctx.solana.getLamports(pubkey))
    if (current >= input.floorLamports) return
    const requestLamports =
      Number(input.floorLamports - current) + LAMPORTS_PER_SOL
    const signature = await ctx.solana.connection.requestAirdrop(
      pubkey,
      requestLamports
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `SolanaFundingTool.planAirdrop ${input.operatorLabel}`
    )
  }

  // ── Step: mint mock SPL to an operator's ATA (write) ─────────────────────

  /** Input for {@link planSplMint} — one mock-SPL mint into the operator's ATA. */
  export interface MintSplInput extends StepInput {
    readonly kind: "SolanaFundingTool.MintSplInput"
    /**
     * Operator's durable `label` handle — its SOL keypair / ATA is resolved
     * from `ctx.keyStore` (NOT its on-chain `account`).
     */
    readonly operatorLabel: string
    /**
     * Token slug code — the config-level identity. The SPL mint ADDRESS is a
     * deploy artifact (`sol-mock-mints.json`) that does not exist when the step
     * is CONSTRUCTED (the outpost deploys later in the same build), so the
     * runner resolves it at run time.
     */
    readonly tokenCode: bigint
    /** Token base units to mint into the operator's ATA. */
    readonly amount: bigint
  }

  /**
   * A single mock-SPL mint into the operator's ATA (creating the ATA on demand),
   * signed by the persisted deployer keypair (the mint authority). The operator
   * identity is resolved from `ctx.keyStore` by its durable `label`; the deployer
   * keypair from the cluster data dir ({@link DeployerKeypairFilename}).
   */
  export function planSplMint<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    tokenCode: bigint,
    amount: bigint
  ): ClusterBuildStep<C, MintSplInput> {
    return ClusterBuildStep.create<C, MintSplInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaFundingTool.MintSplInput",
        operatorLabel,
        tokenCode,
        amount
      },
      runSplMint
    )
  }

  /** Named runner — resolve the mock mint, then ONE `mintMockSplToUser` into the operator's ATA. */
  export async function runSplMint<C extends ClusterBuildContext>(
    ctx: C,
    input: MintSplInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amount > 0n,
      "SolanaFundingTool.planSplMint: amount must be positive"
    )
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    const deployer = loadDeployerKeypair(ctx.config.dataPath)
    const mint = solMintAddress(ctx.config.dataPath, input.tokenCode)
    await mintMockSplToUser(
      ctx.solana.connection,
      deployer,
      new PublicKey(mint),
      solanaKeypair(operator.solana).publicKey,
      input.amount
    )
  }

  /** SPL mock-mint manifest filename in the cluster data dir. */
  export const SolMockMintsFilename = "sol-mock-mints.json"

  /** One row of `sol-mock-mints.json` (harness artifact, no generated equivalent). */
  export interface SolMockMint {
    code: number
    mint: string
    decimals: number
  }

  /**
   * Resolve the persisted mock SPL mint (base58) for a token code from THIS
   * cluster's `sol-mock-mints.json`. Runners call this at RUN time — the
   * manifest does not exist when steps are constructed (the outpost deploys
   * later in the same build), and a configured collateral leg whose mint is
   * missing is a hard failure, never a silent skip.
   */
  export function solMintAddress(dataPath: string, tokenCode: bigint): string {
    const mintsFile = Path.join(dataPath, SolMockMintsFilename)
    Assert.ok(
      Fs.existsSync(mintsFile),
      `SolanaFundingTool: mock SPL mints not found at ${mintsFile}`
    )
    const mints = JSON.parse(
      Fs.readFileSync(mintsFile, "utf8")
    ) as SolMockMint[]
    const found = mints.find(entry => BigInt(entry.code) === tokenCode)
    Assert.ok(
      found != null,
      `SolanaFundingTool: no mock SPL mint persisted for token code ${tokenCode} ` +
        `(persisted codes: ${mints.map(entry => entry.code).join(", ")})`
    )
    return found.mint
  }

  /**
   * Load the persisted mint-authority (deployer) keypair from the cluster data
   * dir — the keypair `SolanaOutpostBootstrapper` writes when it provisions the
   * mock SPL mints (a value helper used inside {@link runSplMint}).
   *
   * @param dataPath - The cluster data directory.
   * @return The deployer keypair.
   * @throws If the deployer keypair has not been created yet.
   */
  export function loadDeployerKeypair(dataPath: string): Keypair {
    return loadKeypair(dataPath, DeployerKeypairName)
  }

  /**
   * Sign, send, and poll-confirm `transaction`. Fetches a recent blockhash
   * inline, sends the raw signed bytes, then defers to {@link confirmSignature}
   * (which bounds each status RPC and periodically re-sends the same bytes so a
   * silently-dropped tx still lands). Namespace-private.
   */
  async function sendAndPoll(
    connection: Connection,
    transaction: Transaction,
    signers: Keypair[],
    label: string
  ): Promise<string> {
    const { blockhash } = await connection.getLatestBlockhash(
      SolanaClient.DefaultCommitment
    )
    transaction.recentBlockhash = blockhash
    transaction.feePayer = signers[0].publicKey
    transaction.sign(...signers)
    const raw = transaction.serialize()
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false
    })
    log.info(`[SolanaFundingTool/${label}] sent signature=${signature}`)
    await confirmSignature(connection, signature, label, {
      rebroadcast: () =>
        connection.sendRawTransaction(raw, { skipPreflight: true })
    })
    return signature
  }
}
