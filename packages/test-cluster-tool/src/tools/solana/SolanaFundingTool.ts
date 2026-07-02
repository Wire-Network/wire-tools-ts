import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction
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
    log.info(`[SolanaFundingTool] createMockSplMint start (decimals=${decimals})`)

    const mintKeypair = Keypair.generate()
    log.info(`[SolanaFundingTool] generated mint pubkey=${mintKeypair.publicKey.toBase58()}`)
    const rentLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: funder.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports: rentLamports,
        programId: TOKEN_PROGRAM_ID
      }),
      createInitializeMint2Instruction(mintKeypair.publicKey, decimals, funder.publicKey, null)
    )
    await sendAndPoll(connection, transaction, [funder, mintKeypair], "createMockSplMint")
    log.info(`[SolanaFundingTool] mint created (${mintKeypair.publicKey.toBase58()})`)
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
    const ata = getAssociatedTokenAddressSync(mint, recipient)
    const ataInfo = await connection.getAccountInfo(ata)
    const transaction = new Transaction()
    if (ataInfo === null)
      transaction.add(
        createAssociatedTokenAccountInstruction(funder.publicKey, ata, recipient, mint)
      )
    transaction.add(createMintToInstruction(mint, ata, funder.publicKey, amount))
    await sendAndPoll(connection, transaction, [funder], "mintMockSplToUser")
    return ata
  }

  /** Persisted mint-authority (deployer) keypair filename in the cluster data dir. */
  export const DeployerKeypairFilename = "sol-deployer-keypair.json"

  // ── Step: airdrop SOL to an operator keypair (write) ─────────────────────

  /** Input for {@link airdrop} — top an operator's SOL keypair up to a floor. */
  export interface AirdropInput extends StepInput {
    readonly kind: "SolanaFundingTool.AirdropInput"
    /** Operator whose SOL keypair is read from `ctx.outputs` and airdropped to. */
    readonly operatorAccount: string
    /** Ensure the operator's SOL keypair holds at least this many lamports. */
    readonly floorLamports: bigint
  }

  /**
   * A single `requestAirdrop` that tops the operator's SOL keypair up to
   * `floorLamports` (a SOL collateral deposit escrows lamports from the depositor,
   * so the keypair must hold the deposit amount + fee headroom before depositing).
   * Idempotent — a keypair already at/above the floor no-ops.
   */
  export function airdrop<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    floorLamports: bigint
  ): ClusterBuildStep<C, AirdropInput> {
    return ClusterBuildStep.create<C, AirdropInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaFundingTool.AirdropInput", operatorAccount, floorLamports },
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
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
    const pubkey = solanaKeypair(operator.solana).publicKey
    const current = BigInt(await ctx.solana.getLamports(pubkey))
    if (current >= input.floorLamports) return
    const requestLamports = Number(input.floorLamports - current) + LAMPORTS_PER_SOL
    const signature = await ctx.solana.connection.requestAirdrop(pubkey, requestLamports)
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `SolanaFundingTool.airdrop ${input.operatorAccount}`
    )
  }

  // ── Step: mint mock SPL to an operator's ATA (write) ─────────────────────

  /** Input for {@link mintSpl} — one mock-SPL mint into the operator's ATA. */
  export interface MintSplInput extends StepInput {
    readonly kind: "SolanaFundingTool.MintSplInput"
    /** Operator whose SOL keypair / ATA is read from `ctx.outputs`. */
    readonly operatorAccount: string
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
   * identity is read from `ctx.outputs`; the deployer keypair from the cluster
   * data dir ({@link DeployerKeypairFilename}).
   */
  export function mintSpl<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorAccount: string,
    tokenCode: bigint,
    amount: bigint
  ): ClusterBuildStep<C, MintSplInput> {
    return ClusterBuildStep.create<C, MintSplInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaFundingTool.MintSplInput", operatorAccount, tokenCode, amount },
      runMintSpl
    )
  }

  /** Named runner — resolve the mock mint, then ONE `mintMockSplToUser` into the operator's ATA. */
  export async function runMintSpl<C extends ClusterBuildContext>(
    ctx: C,
    input: MintSplInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "SolanaFundingTool.mintSpl: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorAccount)
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
   * mock SPL mints (a value helper used inside {@link runMintSpl}).
   */
  export function loadDeployerKeypair(dataPath: string): Keypair {
    const keypairFile = Path.join(dataPath, DeployerKeypairFilename)
    Assert.ok(
      Fs.existsSync(keypairFile),
      `SolanaFundingTool.mintSpl: deployer keypair not found at ${keypairFile}`
    )
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(keypairFile, "utf8")))
    )
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
    const { blockhash } = await connection.getLatestBlockhash(SolanaClient.DefaultCommitment)
    transaction.recentBlockhash = blockhash
    transaction.feePayer = signers[0].publicKey
    transaction.sign(...signers)
    const raw = transaction.serialize()
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: false })
    log.info(`[SolanaFundingTool/${label}] sent signature=${signature}`)
    await confirmSignature(connection, signature, label, {
      rebroadcast: () => connection.sendRawTransaction(raw, { skipPreflight: true })
    })
    return signature
  }
}
