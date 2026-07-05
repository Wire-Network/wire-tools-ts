import Assert from "node:assert"
import * as anchor from "@coral-xyz/anchor"
import { PublicKey, SystemProgram } from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  EthereumLocalReserveStatus,
  Report,
  SolanaCollateralTool,
  SolanaOutpostBootstrapper,
  confirmSignature,
  resolveLatestNonce,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { ethers } from "ethers"
import { SwapPrivateReservesScenarioArtifacts as Artifacts } from "../SwapPrivateReservesScenarioArtifacts.js"
import { SwapPrivateReservesScenarioConstants as Constants } from "../SwapPrivateReservesScenarioConstants.js"

const { SysioContractName } = SysioContracts
const { PdaSeed } = SolanaOutpostBootstrapper

/**
 * The gated private-reserve handshake writes: the outpost `create_reserve`
 * submissions (`isPrivate=true`, creator key riding the attestation) and the
 * depot-side `sysio.reserv::matchreserve` by the authex-linked owner — plus
 * the outpost-local record reads the RESERVE_READY verifies poll.
 */
export namespace SwapPrivateReservesScenarioReserveSteps {
  // ── Step: ETH-native create_reserve (write) ──────────────────────────────

  /** Input for {@link planCreateEthereumReserve}. */
  export interface CreateEthereumReserveInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioReserveSteps.CreateEthereumReserveInput"
    readonly tokenCode: number
    readonly reserveCode: number
    /** Wei escrowed as `msg.value`. */
    readonly escrowWei: bigint
    /** WIRE (raw 9-dp) the depot row requests from the matcher. */
    readonly requestedWireAmount: bigint
  }

  /**
   * Submit the ETH-native `create_reserve` for the private ETH reserve —
   * escrows `msg.value` wei and ships the creator's compressed secp256k1 key
   * (contract-verified to derive to the caller).
   */
  export function planCreateEthereumReserve<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, CreateEthereumReserveInput> {
    return ClusterBuildStep.create<C, CreateEthereumReserveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioReserveSteps.CreateEthereumReserveInput",
        tokenCode: Constants.Reserves.Ethereum.TokenCode,
        reserveCode: Constants.Reserves.PrivateReserveCode,
        escrowWei: Constants.CreateParams.EthereumEscrowWei,
        requestedWireAmount: Constants.CreateParams.EthereumRequestedWire
      },
      runCreateEthereumReserve
    )
  }

  /** Named runner — ONE payable `ReserveManager.create_reserve(...)` write. */
  export async function runCreateEthereumReserve<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateEthereumReserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const reserveManager = Artifacts.loadReserveManager<Artifacts.ReserveManagerPrivateReserveContract>(
      ctx,
      swapUser.ethereumWallet
    )
    const nonce = await resolveLatestNonce(reserveManager)
    const response = await reserveManager.create_reserve(
      BigInt(input.tokenCode),
      BigInt(input.reserveCode),
      input.escrowWei,
      input.requestedWireAmount,
      Constants.CreateParams.ConnectorWeightBps,
      Constants.CreateParams.EthereumName,
      Constants.CreateParams.EthereumDescription,
      true,
      swapUser.ethereumWallet.signingKey.compressedPublicKey,
      { value: input.escrowWei, nonce }
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `create_reserve(ETH/PRIVATE) reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: SOL SPL-branch create_reserve (write) ──────────────────────────

  /** Input for {@link planCreateSolanaReserve}. */
  export interface CreateSolanaReserveInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioReserveSteps.CreateSolanaReserveInput"
    readonly tokenCode: number
    readonly reserveCode: number
    /** USDCSOL base units escrowed from the creator's ATA. */
    readonly escrowChainUnits: bigint
    /** WIRE (raw 9-dp) the depot row requests from the matcher. */
    readonly requestedWireAmount: bigint
  }

  /**
   * Submit the permissionless SPL-branch `create_reserve` IX for the private
   * USDCSOL reserve. Accounts mirror the program's `CreateReserve` struct
   * (`create_reserve.rs`): the per-reserve PDA + vault are `init`-allocated
   * here, the escrow transfers from the creator's ATA into the vault, and the
   * signer's ed25519 key rides the attestation as `creator_pub_key`
   * automatically.
   */
  export function planCreateSolanaReserve<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, CreateSolanaReserveInput> {
    return ClusterBuildStep.create<C, CreateSolanaReserveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioReserveSteps.CreateSolanaReserveInput",
        tokenCode: Constants.Reserves.Solana.TokenCode,
        reserveCode: Constants.Reserves.PrivateReserveCode,
        escrowChainUnits: Constants.CreateParams.SolanaEscrowChainUnits,
        requestedWireAmount: Constants.CreateParams.SolanaRequestedWire
      },
      runCreateSolanaReserve
    )
  }

  /** Named runner — ONE `opp_outpost::create_reserve` IX (SPL branch). */
  export async function runCreateSolanaReserve<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateSolanaReserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const program = SolanaCollateralTool.loadOppOutpostProgram(
      ctx,
      swapUser.solanaKeypair
    )
    const programId = program.programId
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostConfig)],
      programId
    )
    const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutboundMessageBuffer)],
      programId
    )
    const tokenCodeLE = slugNameToLeBuffer(input.tokenCode)
    const reserveCodeLE = slugNameToLeBuffer(input.reserveCode)
    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.Reserve), tokenCodeLE, reserveCodeLE],
      programId
    )
    const [reserveVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.ReserveVault), tokenCodeLE, reserveCodeLE],
      programId
    )
    const usdcSolMint = Artifacts.loadUsdcSolMint(ctx)

    const transaction = await program.methods
      .createReserve(
        new anchor.BN(input.tokenCode),
        new anchor.BN(input.reserveCode),
        new anchor.BN(input.escrowChainUnits.toString()),
        new anchor.BN(input.requestedWireAmount.toString()),
        Constants.CreateParams.ConnectorWeightBps,
        Constants.CreateParams.SolanaName,
        Constants.CreateParams.SolanaDescription,
        true
      )
      .accounts({
        creator: swapUser.solanaKeypair.publicKey,
        config: configPda,
        reserve: reservePda,
        reserveVault: reserveVaultPda,
        mint: usdcSolMint,
        creatorAta: getAssociatedTokenAddressSync(
          usdcSolMint,
          swapUser.solanaKeypair.publicKey
        ),
        outboundMessageBuffer: outboundMessageBufferPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY
      })
      .signers([swapUser.solanaKeypair])
      .transaction()
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [swapUser.solanaKeypair],
      { skipPreflight: false }
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      "create_reserve(USDCSOL/PRIVATE)"
    )
  }

  // ── Step: depot matchreserve (write) ─────────────────────────────────────

  /** Input for {@link planMatchReserve}. */
  export interface MatchReserveInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioReserveSteps.MatchReserveInput"
    readonly chainCode: number
    readonly tokenCode: number
    readonly reserveCode: number
    /** The matcher WIRE account (must be authex-linked to the creator key). */
    readonly matcher: string
    /** Must equal the row's `requested_wire_amount` exactly. */
    readonly wireAmount: bigint
  }

  /**
   * Push `sysio.reserv::matchreserve` as the owner for one `(chain, token,
   * reserve)` triple — escrows the requested WIRE, flips the depot row ACTIVE
   * synchronously, and queues RESERVE_READY back to the outpost.
   */
  export function planMatchReserve<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: number,
    tokenCode: number,
    wireAmount: bigint
  ): ClusterBuildStep<C, MatchReserveInput> {
    return ClusterBuildStep.create<C, MatchReserveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioReserveSteps.MatchReserveInput",
        chainCode,
        tokenCode,
        reserveCode: Constants.Reserves.PrivateReserveCode,
        matcher: Constants.Accounts.Owner,
        wireAmount
      },
      runMatchReserve
    )
  }

  /** Named runner — ONE typed `matchreserve` invoke, authorized by the owner. */
  export async function runMatchReserve<C extends ClusterBuildContext>(
    ctx: C,
    input: MatchReserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.matchreserve.invoke(
        {
          chain_code: { value: input.chainCode },
          token_code: { value: input.tokenCode },
          reserve_code: { value: input.reserveCode },
          matcher: input.matcher,
          wire_amount: Number(input.wireAmount)
        },
        { authorization: [{ actor: input.matcher, permission: "active" }] }
      )
  }

  // ── Outpost-local record reads (polled by the RESERVE_READY verifies) ────

  /** True once the ETH outpost's local PRIVATE record reports ACTIVE (a read). */
  export async function readEthereumLocalReserveActive<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean> {
    const reserveManager = Artifacts.loadReserveManager<Artifacts.ReserveManagerPrivateReserveContract>(
      ctx,
      ctx.ethereum.wallet.signer
    )
    const record = await reserveManager.getReserve(
      BigInt(Constants.Reserves.Ethereum.TokenCode),
      BigInt(Constants.Reserves.PrivateReserveCode)
    )
    return Number(record.status) === EthereumLocalReserveStatus.ACTIVE
  }

  /**
   * True once the SOL outpost's PRIVATE Reserve PDA reports `Active` (a read).
   * Required before Phase B — `request_swap_spl` constraint-gates on the local
   * status, so the RESERVE_READY round-trip must have landed.
   */
  export async function readSolanaLocalReserveActive<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean> {
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const program = SolanaCollateralTool.loadOppOutpostProgram(
      ctx,
      swapUser.solanaKeypair
    )
    const [reservePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(PdaSeed.Reserve),
        slugNameToLeBuffer(Constants.Reserves.Solana.TokenCode),
        slugNameToLeBuffer(Constants.Reserves.PrivateReserveCode)
      ],
      program.programId
    )
    const account = await (
      program.account as Record<string, anchor.AccountClient<anchor.Idl>>
    ).reserve.fetch(reservePda)
    const status = (account as { status?: unknown }).status
    return typeof status === "object" && status !== null && "active" in status
  }

  /**
   * Encode a slug_name `number` as an 8-byte little-endian Buffer matching
   * the program's `to_le_bytes()` PDA seed derivation.
   */
  function slugNameToLeBuffer(value: number): Buffer {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(value))
    return buffer
  }
}
