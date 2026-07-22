/**
 * SolanaCollateralTool — Step factories for the Solana-outpost
 * `opp-outpost::deposit` / `deposit_non_native` collateral writes. Every Anchor
 * WRITE is its OWN {@link ClusterBuildStep} so the `Report` records it:
 * {@link planDeposit} (native SOL) and {@link planNonNativeDeposit} (SPL). Each runner
 * reads the operator identity from `ctx.outputs`, builds the `opp_outpost`
 * program bound to the operator's keypair, resolves the program PDAs, and submits
 * exactly ONE deposit ix. PDA derivation + IDL/program loading are pure value
 * helpers used INSIDE the runners.
 */

import Assert from "node:assert"
import * as anchor from "@coral-xyz/anchor"
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  type Keypair
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { OperatorType } from "@wireio/opp-typescript-models"
import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import { SolanaFundingTool } from "./SolanaFundingTool.js"
import { SolanaOutpostProgramTool } from "./SolanaOutpostProgramTool.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { solanaKeypair } from "../../utils/keyPairUtils.js"
import { Report } from "../../report/Report.js"

/** PDA seeds — kept in sync with `wire-solana/programs/liqsol-core/src/states/opp_states.rs`. */
const OutpostConfigSeed = Buffer.from("outpost_config")
const OutboundMessageBufferSeed = Buffer.from("outbound_message_buffer")
const OperatorRegistrySeed = Buffer.from("operator_registry")
const VaultSeed = Buffer.from("outpost_vault")
/** Per-`token_code` SPL collateral vault seed — matches `deposit_non_native.rs`. */
const CollateralVaultSeed = Buffer.from("collateral_vault")

export namespace SolanaCollateralTool {
  // ── Step: native SOL planDeposit (`opp-outpost::deposit`) ────────────────────

  /** Input for {@link planDeposit} — one native-SOL collateral deposit write. */
  export interface DepositInput extends StepInput {
    readonly kind: "SolanaCollateralTool.DepositInput"
    /** Operator whose identity is read from `ctx.outputs`. */
    readonly operatorLabel: string
    readonly operatorType: OperatorType
    /** 8-byte slug_name (`uint64`) of the deposited token (native `SOL`). */
    readonly tokenCode: bigint
    /** Lamports to escrow. */
    readonly amount: bigint
  }

  /** A single native-SOL collateral deposit write to `opp-outpost::deposit`. */
  export function planDeposit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    operatorType: OperatorType,
    tokenCode: bigint,
    amount: bigint
  ): ClusterBuildStep<C, DepositInput> {
    return ClusterBuildStep.create<C, DepositInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaCollateralTool.DepositInput",
        operatorLabel,
        operatorType,
        tokenCode,
        amount
      },
      runDeposit
    )
  }

  /** Named runner — ONE `opp-outpost::deposit` ix, signed by the operator keypair. */
  export async function runDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "SolanaCollateralTool.planDeposit: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    const keypair = solanaKeypair(operator.solana)
    const program = loadOppOutpostProgram(ctx, keypair)
    const programId = program.programId
    const transaction = await program.methods
      .deposit(
        input.operatorType,
        new anchor.BN(input.tokenCode.toString()),
        new anchor.BN(input.amount.toString())
      )
      .accounts({
        depositor: keypair.publicKey,
        config: pda(OutpostConfigSeed, programId),
        operatorRegistry: pda(OperatorRegistrySeed, programId),
        outboundMessageBuffer: pda(OutboundMessageBufferSeed, programId),
        vault: pda(VaultSeed, programId),
        systemProgram: SystemProgram.programId
      })
      .signers([keypair])
      .transaction()
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [keypair],
      { skipPreflight: false }
    )
    await confirmSignature(ctx.solana.connection, signature, "SolanaCollateralTool.planDeposit")
  }

  // ── Step: SPL planDeposit (`opp-outpost::deposit_non_native`) ────────────────

  /** Input for {@link planNonNativeDeposit} — one SPL collateral deposit write. */
  export interface DepositNonNativeInput extends StepInput {
    readonly kind: "SolanaCollateralTool.DepositNonNativeInput"
    readonly operatorLabel: string
    readonly chainCode: bigint
    /**
     * Token slug code — the config-level identity. The SPL mint ADDRESS is a
     * deploy artifact the runner resolves at run time (it does not exist when
     * the step is constructed).
     */
    readonly tokenCode: bigint
    readonly reserveCode: bigint
    readonly operatorType: OperatorType
    readonly amount: bigint
  }

  /** A single `opp-outpost::deposit_non_native` SPL write, signed by the operator keypair. */
  export function planNonNativeDeposit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    chainCode: bigint,
    tokenCode: bigint,
    reserveCode: bigint,
    operatorType: OperatorType,
    amount: bigint
  ): ClusterBuildStep<C, DepositNonNativeInput> {
    return ClusterBuildStep.create<C, DepositNonNativeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaCollateralTool.DepositNonNativeInput",
        operatorLabel,
        chainCode,
        tokenCode,
        reserveCode,
        operatorType,
        amount
      },
      runNonNativeDeposit
    )
  }

  /** Named runner — ONE `opp-outpost::deposit_non_native` SPL write. */
  export async function runNonNativeDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositNonNativeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "SolanaCollateralTool.planNonNativeDeposit: amount must be positive")
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    const keypair = solanaKeypair(operator.solana)
    const program = loadOppOutpostProgram(ctx, keypair)
    const programId = program.programId
    const mint = new PublicKey(
      SolanaFundingTool.solMintAddress(ctx.config.dataPath, input.tokenCode)
    )
    const tokenCodeLeBytes = Buffer.alloc(8)
    tokenCodeLeBytes.writeBigUInt64LE(input.tokenCode)
    const transaction = await program.methods
      .depositNonNative(
        new anchor.BN(input.chainCode.toString()),
        new anchor.BN(input.tokenCode.toString()),
        new anchor.BN(input.reserveCode.toString()),
        input.operatorType,
        new anchor.BN(input.amount.toString())
      )
      .accounts({
        depositor: keypair.publicKey,
        config: pda(OutpostConfigSeed, programId),
        operatorRegistry: pda(OperatorRegistrySeed, programId),
        outboundMessageBuffer: pda(OutboundMessageBufferSeed, programId),
        mint,
        depositorAta: getAssociatedTokenAddressSync(mint, keypair.publicKey),
        collateralVault: pda(CollateralVaultSeed, programId, tokenCodeLeBytes),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY
      })
      .signers([keypair])
      .transaction()
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [keypair],
      { skipPreflight: false }
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      "SolanaCollateralTool.planNonNativeDeposit"
    )
  }

  // ── value helpers (PDA / IDL loads — executed INSIDE runners) ────────────

  /** Derive a program PDA from its seeds (a pure read). */
  function pda(...seedsAndProgramId: [Buffer, PublicKey, Buffer?]): PublicKey {
    const [firstSeed, programId, secondSeed] = seedsAndProgramId
    const seeds = secondSeed != null ? [firstSeed, secondSeed] : [firstSeed]
    return PublicKey.findProgramAddressSync(seeds, programId)[0]
  }

  /**
   * Build the OPP outpost Anchor program (hosted in `liqsol_core` since the
   * clean-room rewrite) bound to `keypair` (its own signer for the deposit
   * ix). IDL from `<solanaPath>/target/idl/liqsol_core.json`; connection from
   * `ctx.solana`.
   */
  export function loadOppOutpostProgram<C extends ClusterBuildContext>(
    ctx: C,
    keypair: Keypair
  ): anchor.Program<anchor.Idl> {
    const idl = SolanaOutpostProgramTool.readIdl(ctx.config.solanaPath)
    const provider = new anchor.AnchorProvider(
      ctx.solana.connection,
      new anchor.Wallet(keypair),
      { commitment: SolanaClient.DefaultCommitment }
    )
    return new anchor.Program(idl, provider)
  }
}
