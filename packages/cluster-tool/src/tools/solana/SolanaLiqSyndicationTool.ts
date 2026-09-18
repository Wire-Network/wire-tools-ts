/**
 * SolanaLiqSyndicationTool — Step factories for the REAL `liqsol_core`
 * syndication surface on the Solana outpost. Every Anchor WRITE is its OWN
 * {@link ClusterBuildStep} so the `Report` records it:
 * {@link SolanaLiqSyndicationTool.planDepositForLiqsol} (SOL → liqSOL 1:1),
 * {@link SolanaLiqSyndicationTool.planSetWireState} (the admin launch-state
 * flip), {@link SolanaLiqSyndicationTool.planSynd} (the user syndicating into
 * the outpost-owned pool, which queues `SYNDICATE_LIQ`),
 * {@link SolanaLiqSyndicationTool.planInjectBonusSyndYield} (the permissionless
 * SOL-funded donation that credits the syndicated pool) and
 * {@link SolanaLiqSyndicationTool.planReportLiqYield} (the permissionless crank
 * that queues `LIQ_YIELD` for the delta above the watermark).
 *
 * Nothing here injects an attestation: each step drives the same instruction a
 * real user / admin / cranker drives, and the outbound `SYNDICATE_LIQ` /
 * `LIQ_YIELD` entries are produced by the program itself.
 *
 * PDA derivation and program loading are pure value helpers executed INSIDE the
 * runners; every seed is a named constant in {@link SolanaLiqSyndicationTool.PdaSeed},
 * cross-checked against `wire-solana/programs/liqsol-core` (and `liqsol-token` /
 * `transfer-hook` for the mint + hook seeds).
 */

import Assert from "node:assert"

import { Either } from "@3fv/prelude-ts"
import * as anchor from "@coral-xyz/anchor"
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  StakeProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY
} from "@solana/web3.js"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"

import {
  WireState,
  WireStateTransitions,
  canTransitionWireState,
  wireStateVariant,
  type AnchorEnumVariant
} from "./SolanaAnchorEnumTool.js"
import { LiqsolPdaSeed } from "./LiqsolPdaSeed.js"
import { getLogger } from "../../logging/Logger.js"
import { SolanaFundingTool } from "./SolanaFundingTool.js"
import { SolanaOutpostProgramTool } from "./SolanaOutpostProgramTool.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { SolanaOutpostBootstrapper } from "../../orchestration/solana/SolanaOutpostBootstrapper.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { pollUntil } from "../../orchestration/StepTools.js"
import { Report } from "../../report/Report.js"

const log = getLogger(__filename)

export namespace SolanaLiqSyndicationTool {
  /**
   * The liqsol PDA seeds — an ALIAS of {@link LiqsolPdaSeed}, which the
   * bootstrap phase that creates these accounts derives from too. One
   * declaration, this name kept so every call site here reads
   * `PdaSeed.<Account>`.
   */
  export import PdaSeed = LiqsolPdaSeed

  /** Prefix of the ephemeral stake-account seed a deposit creates (`ephemeral_<seed>`). */
  export const EphemeralStakeSeedPrefix = "ephemeral_"
  /** Compute-unit ceiling for a `sol_to_liqsol` deposit (stake CPI + mint CPI + hook). */
  export const DepositComputeUnitLimit = 1_000_000
  /** Compute-unit ceiling for the Token-2022 + transfer-hook syndication instructions. */
  export const SyndicationComputeUnitLimit = 800_000

  // ── value helpers (PDA derivation / program loading — run INSIDE runners) ──

  /** The liqsol PDAs that do not depend on a user, resolved from `ctx.config.solanaPath`. */
  export interface BasePdas {
    globalState: PublicKey
    globalConfig: PublicKey
    poolAuthority: PublicKey
    distributionState: PublicKey
    bucketAuthority: PublicKey
    liqsolMint: PublicKey
    liqsolMintAuthority: PublicKey
    extraAccountMetaList: PublicKey
    liqsolPoolAta: PublicKey
    liqsolPoolUserRecord: PublicKey
    bucketTokenAccount: PublicKey
    bucketUserRecord: PublicKey
    reservePool: PublicKey
    depositAuthority: PublicKey
    vault: PublicKey
    stakeControllerState: PublicKey
    payoutState: PublicKey
    payRateHistory: PublicKey
    outpostConfig: PublicKey
    outboundMessageBuffer: PublicKey
    liqsolCoreProgram: PublicKey
    liqsolTokenProgram: PublicKey
    transferHookProgram: PublicKey
  }

  /** The per-user liqsol PDAs, plus every {@link BasePdas} member. */
  export interface UserPdas extends BasePdas {
    user: PublicKey
    userAta: PublicKey
    userUserRecord: PublicKey
    outpostAccount: PublicKey
  }

  /**
   * Derive every user-independent liqsol PDA. A pure value helper (no chain
   * call), so it is called freely inside step runners.
   *
   * @param solanaPath - The `wire-solana` repo root (supplies the program ids).
   * @returns The derived addresses.
   */
  export function deriveBasePdas(solanaPath: string): BasePdas {
    const { AnchorProgram, assertProgramId, derivePda } =
        SolanaOutpostProgramTool,
      liqsolCoreProgram = assertProgramId(solanaPath, AnchorProgram.liqsolCore),
      liqsolTokenProgram = assertProgramId(
        solanaPath,
        AnchorProgram.liqsolToken
      ),
      transferHookProgram = assertProgramId(
        solanaPath,
        AnchorProgram.transferHook
      ),
      core = (seed: string, ...rest: Buffer[]): PublicKey =>
        derivePda(liqsolCoreProgram, Buffer.from(seed), ...rest),
      liqsolMint = derivePda(
        liqsolTokenProgram,
        Buffer.from(PdaSeed.LiqsolMint)
      ),
      poolAuthority = core(PdaSeed.PoolAuthority),
      bucketAuthority = core(PdaSeed.BucketAuthority),
      liqsolPoolAta = getAssociatedTokenAddressSync(
        liqsolMint,
        poolAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      ),
      bucketTokenAccount = getAssociatedTokenAddressSync(
        liqsolMint,
        bucketAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      )
    return {
      globalState: core(PdaSeed.GlobalState),
      globalConfig: core(SolanaOutpostBootstrapper.PdaSeed.GlobalConfig),
      poolAuthority,
      distributionState: core(PdaSeed.DistributionState),
      bucketAuthority,
      liqsolMint,
      liqsolMintAuthority: derivePda(
        liqsolTokenProgram,
        Buffer.from(PdaSeed.LiqsolMintAuthority)
      ),
      extraAccountMetaList: derivePda(
        transferHookProgram,
        Buffer.from(PdaSeed.ExtraAccountMetaList),
        liqsolMint.toBuffer()
      ),
      liqsolPoolAta,
      liqsolPoolUserRecord: core(PdaSeed.UserRecord, liqsolPoolAta.toBuffer()),
      bucketTokenAccount,
      bucketUserRecord: core(
        PdaSeed.UserRecord,
        bucketTokenAccount.toBuffer()
      ),
      reservePool: core(PdaSeed.ReservePool),
      depositAuthority: core(PdaSeed.DepositAuthority),
      vault: core(PdaSeed.Vault),
      stakeControllerState: core(PdaSeed.StakeControllerState),
      payoutState: core(PdaSeed.PayoutState),
      payRateHistory: core(PdaSeed.PayRateHistory),
      outpostConfig: core(SolanaOutpostBootstrapper.PdaSeed.OutpostConfig),
      outboundMessageBuffer: core(
        SolanaOutpostBootstrapper.PdaSeed.OutboundMessageBuffer
      ),
      liqsolCoreProgram,
      liqsolTokenProgram,
      transferHookProgram
    }
  }

  /**
   * Derive every liqsol PDA for `user` — {@link deriveBasePdas} plus the user's
   * liqSOL ATA, distribution record and pre-launch outpost account.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @param user - The user's Solana wallet pubkey.
   * @returns The derived addresses.
   */
  export function deriveUserPdas(
    solanaPath: string,
    user: PublicKey
  ): UserPdas {
    const base = deriveBasePdas(solanaPath),
      userAta = getAssociatedTokenAddressSync(
        base.liqsolMint,
        user,
        false,
        TOKEN_2022_PROGRAM_ID
      )
    return {
      ...base,
      user,
      userAta,
      userUserRecord: SolanaOutpostProgramTool.derivePda(
        base.liqsolCoreProgram,
        Buffer.from(PdaSeed.UserRecord),
        userAta.toBuffer()
      ),
      outpostAccount: SolanaOutpostProgramTool.derivePda(
        base.liqsolCoreProgram,
        Buffer.from(PdaSeed.OutpostAccount),
        user.toBuffer()
      )
    }
  }

  /**
   * An instruction's account map — the exact object a runner hands to Anchor's
   * `.accounts()` / `.accountsStrict()`.
   *
   * Every builder below is PURE (PDAs + signer pubkeys in, a map out) for one
   * reason: with `resolution = false` in wire-solana's `Anchor.toml` nothing is
   * auto-resolved, so a renamed key throws only at run time deep inside a flow,
   * and non-strict `.accounts()` silently IGNORES an extra key. Exporting the
   * map lets a unit test build the real instruction from the real IDL and
   * compare the resolved keys — the runner and the test cannot drift because
   * they call the same function.
   *
   * `null` is a legal value: it is how Anchor spells `None` for an `Option`
   * account.
   */
  export type InstructionAccounts = Record<string, PublicKey>

  /** One instruction's exported account map, paired with the IDL name it must match. */
  export interface InstructionAccountMap {
    /** The instruction's name as Anchor's camelCased IDL spells it. */
    readonly instruction: string
    /** The map the runner hands `.accounts()`. */
    readonly accounts: InstructionAccounts
  }

  /**
   * Every exported account map, built against `solanaPath`'s derived PDAs — the
   * enumeration {@link assertAccountMapsMatchIdl} walks, so adding a driven
   * instruction without listing it here is the one way to escape that check.
   *
   * A pure value helper. The pubkeys are irrelevant to the caller (only the
   * KEYS are compared), so the program id stands in for every signer.
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @returns One entry per driven instruction.
   */
  export function instructionAccountMaps(
    solanaPath: string
  ): ReadonlyArray<InstructionAccountMap> {
    const base = deriveBasePdas(solanaPath),
      // Any pubkey does; the program's own id is the one always in hand.
      placeholder = base.liqsolCoreProgram,
      user = deriveUserPdas(solanaPath, placeholder)
    return [
      {
        instruction: "solToLiqsol",
        accounts: depositForLiqsolAccounts(user, placeholder)
      },
      {
        instruction: "setWireState",
        accounts: setWireStateAccounts(base, placeholder)
      },
      {
        instruction: "setTokenAddress",
        accounts: setLiqTokenAddressAccounts(base, placeholder)
      },
      { instruction: "synd", accounts: syndAccounts(user) },
      {
        instruction: "injectBonusSyndYield",
        accounts: injectBonusSyndYieldAccounts(base, placeholder)
      },
      {
        instruction: "reportLiqYield",
        accounts: reportLiqYieldAccounts(base, placeholder)
      }
    ]
  }

  /**
   * Assert every exported account map names exactly the accounts the DEPLOYED
   * IDL declares, in the spelling Anchor's coder uses.
   *
   * wire-solana sets `resolution = false`, so Anchor fills in nothing: a
   * renamed or added account is not a type error and not a test failure — it is
   * a run-time revert several minutes into a flow, on a cluster that has
   * already been built. This check runs at bootstrap, against the IDL on disk,
   * and names the instruction and the offending keys.
   *
   * The comparison is against `Program`'s OWN converted IDL rather than a
   * hand-rolled snake-to-camel pass, so it cannot disagree with the coder the
   * runners actually call.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @throws If any map names an account the IDL does not, or misses one.
   */
  export function assertAccountMapsMatchIdl<C extends ClusterBuildContext>(
    ctx: C
  ): void {
    const { instructions } = SolanaOutpostProgramTool.loadReadOnlyProgram(
      ctx.solana.connection,
      ctx.config.solanaPath
    ).idl
    instructionAccountMaps(ctx.config.solanaPath).forEach(
      ({ instruction, accounts }) => {
        const declared = instructions.find(({ name }) => name === instruction)
        Assert.ok(
          declared,
          `SolanaLiqSyndicationTool: the deployed liqsol_core IDL declares no ` +
            `'${instruction}' instruction — the harness drives one that no longer exists.`
        )
        const expected = declared.accounts.map(({ name }) => name),
          supplied = Object.keys(accounts),
          missing = expected.filter(name => !supplied.includes(name)),
          extra = supplied.filter(name => !expected.includes(name))
        Assert.ok(
          missing.length === 0 && extra.length === 0,
          `SolanaLiqSyndicationTool: the '${instruction}' account map has drifted from the ` +
            `deployed IDL — missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]. ` +
            `With Anchor resolution disabled a missing account reverts at run time and an ` +
            `unexpected one is silently dropped, so fix the map in this file.`
        )
      }
    )
  }

  /**
   * Build the `liqsol_core` Anchor program bound to `keypair` as its provider
   * wallet — the ONE program construction for this tool.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @param keypair - The signer the provider's wallet wraps.
   * @returns The Anchor program.
   */
  export function loadLiqsolProgram<C extends ClusterBuildContext>(
    ctx: C,
    keypair: Keypair
  ): anchor.Program<anchor.Idl> {
    return SolanaOutpostProgramTool.loadProgram(
      ctx.solana.connection,
      keypair,
      ctx.config.solanaPath
    )
  }

  /**
   * The `GlobalState` fields the liq-yield report is validated against — the
   * MINIMUM real data a consumer needs, decoded from the on-chain account
   * through the program's own Anchor coder.
   */
  export interface LiqYieldState {
    /** Total liqSOL yield the syndicated pool has accumulated (base units). */
    yieldAccumulatedLiqsol: bigint
    /** Watermark — the accumulated yield already reported to the depot. */
    liqYieldReported: bigint
    /** The outpost's shared, strictly-increasing liq-attestation sequence. */
    liqSequence: bigint
  }

  /**
   * Name of the `GlobalState` account as the program's Anchor coder keys it.
   *
   * CAMELCASE, not the IDL's own `GlobalState`: `new anchor.Program(...)` runs
   * `convertIdlToCamelCase` over the IDL before building its coder, so the
   * coder's account table is keyed by the camelCased name. Passing the raw IDL
   * spelling throws `Account not found: GlobalState`.
   */
  export const GlobalStateAccountName = "globalState"

  /**
   * The `GlobalState` fields this tool consumes, as the Anchor coder decodes
   * them: `u64`s as `BN`, the `WireState` enum as a single-key tagged union.
   */
  interface GlobalStateAccount {
    yieldAccumulatedLiqsol: anchor.BN
    liqYieldReported: anchor.BN
    liqSequence: anchor.BN
    wireState: AnchorEnumVariant
  }

  /**
   * Read the liq-yield accounting off `GlobalState`. A READ, so it runs freely
   * inside a runner or a verify step; the `report_liq_yield` crank's own
   * `LIQYield` amount IS the delta between {@link LiqYieldState.liqYieldReported}
   * before and after it.
   *
   * Decoded through the program's OWN Anchor coder — the generated IDL is the
   * authority for this account's layout, so nothing here re-declares it beyond
   * the three fields consumed.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @returns The decoded liq-yield accounting.
   * @throws If `GlobalState` has not been initialized (`anchor run init-wire-config`).
   */
  export async function readLiqYieldState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<LiqYieldState> {
    const state = await readGlobalState(ctx)
    return {
      yieldAccumulatedLiqsol: BigInt(state.yieldAccumulatedLiqsol.toString()),
      liqYieldReported: BigInt(state.liqYieldReported.toString()),
      liqSequence: BigInt(state.liqSequence.toString())
    }
  }

  /**
   * The outpost's current launch state (`GlobalState.wire_state`), decoded from
   * the Anchor coder's tagged-union representation back onto {@link WireState}.
   * A READ — callers use it to assert the pre-state of a transition rather than
   * discovering it from an on-chain revert.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @returns The current launch state.
   * @throws If `GlobalState` is absent, or carries a variant this enum does not
   *   name (a program/enum drift worth failing loudly on).
   */
  export async function readWireState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<WireState> {
    const { wireState } = await readGlobalState(ctx),
      // Anchor decodes a unit-variant enum as a single-key object whose key is
      // the camelCased variant — the same spelling `wireStateVariant` encodes.
      [variant] = Object.keys(wireState ?? {})
    Assert.ok(
      variant != null && variant in WireState,
      "SolanaLiqSyndicationTool.readWireState: GlobalState.wire_state decoded to " +
        `${JSON.stringify(wireState)}, which names no WireState member`
    )
    return variant as WireState
  }

  /**
   * Decode the whole `GlobalState` account through the program's OWN Anchor
   * coder, reached via {@link SolanaOutpostProgramTool.loadReadOnlyProgram} —
   * a READ needs the IDL's layouts and nothing else: no wallet, no keypair.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @returns The decoded account.
   * @throws If `GlobalState` has not been initialized (`anchor run init-wire-config`).
   */
  async function readGlobalState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<GlobalStateAccount> {
    const pdas = deriveBasePdas(ctx.config.solanaPath),
      account = await ctx.solana.connection.getAccountInfo(pdas.globalState)
    Assert.ok(
      account != null,
      `SolanaLiqSyndicationTool.readGlobalState: GlobalState ${pdas.globalState.toBase58()} ` +
        "does not exist — the liqsol surface was never initialized"
    )
    return SolanaOutpostProgramTool.loadReadOnlyProgram(
      ctx.solana.connection,
      ctx.config.solanaPath
    ).coder.accounts.decode<GlobalStateAccount>(
      GlobalStateAccountName,
      account.data
    )
  }

  /**
   * Submit a built transaction signed by `signer`, then poll-confirm it — the
   * ONE submission path for this tool's runners.
   *
   * @param ctx - The build context (supplies the recording connection).
   * @param transaction - The built, unsigned transaction.
   * @param signer - The keypair that signs and pays.
   * @param label - Confirmation label surfaced on timeout.
   */
  async function submit<C extends ClusterBuildContext>(
    ctx: C,
    transaction: anchor.web3.Transaction,
    signer: Keypair,
    label: string
  ): Promise<void> {
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [signer],
      { skipPreflight: false }
    )
    await confirmSignature(ctx.solana.connection, signature, label)
  }


  // ── account maps (pure — the ONE definition the runners AND the tests use) ──

  /**
   * `sol_to_liqsol`'s 25 accounts.
   *
   * @param pdas - The depositing user's derived liqsol addresses.
   * @param ephemeralStake - The per-deposit stake account (`createWithSeed`).
   * @returns The account map.
   */
  export function depositForLiqsolAccounts(
    pdas: UserPdas,
    ephemeralStake: PublicKey
  ): InstructionAccounts {
    return {
      user: pdas.user,
      depositAuthority: pdas.depositAuthority,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      liqsolProgram: pdas.liqsolTokenProgram,
      payRateHistory: pdas.payRateHistory,
      stakeProgram: StakeProgram.programId,
      liqsolMint: pdas.liqsolMint,
      userAta: pdas.userAta,
      liqsolMintAuthority: pdas.liqsolMintAuthority,
      reservePool: pdas.reservePool,
      vault: pdas.vault,
      ephemeralStake,
      controllerState: pdas.stakeControllerState,
      payoutState: pdas.payoutState,
      bucketAuthority: pdas.bucketAuthority,
      bucketTokenAccount: pdas.bucketTokenAccount,
      userRecord: pdas.userUserRecord,
      distributionState: pdas.distributionState,
      globalConfig: pdas.globalConfig,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      clock: SYSVAR_CLOCK_PUBKEY,
      stakeHistory: SYSVAR_STAKE_HISTORY_PUBKEY,
      rent: SYSVAR_RENT_PUBKEY
    }
  }

  /**
   * `set_wire_state`'s admin-gated accounts.
   *
   * @param pdas - The outpost's derived liqsol addresses.
   * @param admin - The liqsol `global_config.admin` signer.
   * @returns The account map.
   */
  export function setWireStateAccounts(
    pdas: BasePdas,
    admin: PublicKey
  ): InstructionAccounts {
    return {
      admin,
      globalConfig: pdas.globalConfig,
      globalState: pdas.globalState
    }
  }

  /**
   * `set_token_address`'s admin-gated accounts.
   *
   * @param pdas - The outpost's derived liqsol addresses.
   * @param admin - The liqsol `global_config.admin` signer.
   * @returns The account map.
   */
  export function setLiqTokenAddressAccounts(
    pdas: BasePdas,
    admin: PublicKey
  ): InstructionAccounts {
    return {
      admin,
      globalConfig: pdas.globalConfig,
      config: pdas.outpostConfig
    }
  }

  /**
   * `synd`'s 22 accounts, in its PostLaunch form: the outbound buffer + config
   * are REQUIRED and both `Option` accounts (`outpost_account`,
   * `pretoken_purchase_history`) are `None`.
   *
   * @param pdas - The syndicating user's derived liqsol addresses.
   * @returns The account map.
   */
  export function syndAccounts(pdas: UserPdas): InstructionAccounts {
    return {
      // PostLaunch REQUIRES the outbound buffer + config (the attestation
      // targets them) and takes `outpost_account` as None — the mirror image
      // of the pre-launch branch.
      outboundMessageBuffer: pdas.outboundMessageBuffer,
      config: pdas.outpostConfig,
      user: pdas.user,
      liqsolMint: pdas.liqsolMint,
      globalState: pdas.globalState,
      distributionState: pdas.distributionState,
      userAta: pdas.userAta,
      poolAuthority: pdas.poolAuthority,
      bucketAuthority: pdas.bucketAuthority,
      bucketTokenAccount: pdas.bucketTokenAccount,
      bucketUserRecord: pdas.bucketUserRecord,
      senderUserRecord: pdas.userUserRecord,
      receiverUserRecord: pdas.liqsolPoolUserRecord,
      extraAccountMetaList: pdas.extraAccountMetaList,
      liqsolCoreProgram: pdas.liqsolCoreProgram,
      transferHookProgram: pdas.transferHookProgram,
      liqsolPoolAta: pdas.liqsolPoolAta,
      outpostAccount: null,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      // BOTH Option accounts are None PostLaunch: the handler reads neither
      // the per-user `outpost_account` nor the pretoken history, and
      // `close_pretoken_singletons` may have closed the latter — passing a
      // closed account as Some(...) fails Anchor's deserialization before
      // the handler runs, which reads as a program bug.
      pretokenPurchaseHistory: null
    }
  }

  /**
   * `inject_bonus_synd_yield`'s 13 accounts.
   *
   * @param pdas - The outpost's derived liqsol addresses.
   * @param donor - The signer whose lamports fund the donation.
   * @returns The account map.
   */
  export function injectBonusSyndYieldAccounts(
    pdas: BasePdas,
    donor: PublicKey
  ): InstructionAccounts {
    return {
      donor,
      globalState: pdas.globalState,
      distributionState: pdas.distributionState,
      liqsolMint: pdas.liqsolMint,
      poolAuthority: pdas.poolAuthority,
      liqsolPoolAta: pdas.liqsolPoolAta,
      reservePool: pdas.reservePool,
      depositAuthority: pdas.depositAuthority,
      liqsolProgram: pdas.liqsolTokenProgram,
      liqsolMintAuthority: pdas.liqsolMintAuthority,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId
    }
  }

  /**
   * `report_liq_yield`'s 18 accounts.
   *
   * @param pdas - The outpost's derived liqsol addresses.
   * @param cranker - The permissionless (unconstrained) signer.
   * @returns The account map.
   */
  export function reportLiqYieldAccounts(
    pdas: BasePdas,
    cranker: PublicKey
  ): InstructionAccounts {
    return {
      cranker,
      liqsolMint: pdas.liqsolMint,
      globalState: pdas.globalState,
      distributionState: pdas.distributionState,
      poolAuthority: pdas.poolAuthority,
      bucketAuthority: pdas.bucketAuthority,
      bucketTokenAccount: pdas.bucketTokenAccount,
      bucketUserRecord: pdas.bucketUserRecord,
      liqsolPoolAta: pdas.liqsolPoolAta,
      poolUserRecord: pdas.liqsolPoolUserRecord,
      extraAccountMetaList: pdas.extraAccountMetaList,
      liqsolCoreProgram: pdas.liqsolCoreProgram,
      transferHookProgram: pdas.transferHookProgram,
      config: pdas.outpostConfig,
      outboundMessageBuffer: pdas.outboundMessageBuffer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId
    }
  }

  // ── Step: SOL → liqSOL deposit (`liqsol_core::sol_to_liqsol`) ────────────

  /** Input for {@link planDepositForLiqsol} — one `sol_to_liqsol` write. */
  export interface DepositForLiqsolInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.DepositForLiqsolInput"
    /** Durable handle of the depositing user's persisted keypair. */
    readonly userName: string
    /** Lamports deposited; the user is minted the same number of liqSOL base units. */
    readonly lamports: bigint
    /**
     * `u32` seed of the ephemeral stake account this deposit creates
     * (`createWithSeed(user, "ephemeral_<seed>", StakeProgram)`). Carried on the
     * INPUT, not drawn in the runner, so the Report records the exact address
     * the transaction used and the step is reproducible.
     */
    readonly ephemeralStakeSeed: number
  }

  /**
   * A single `sol_to_liqsol` write: the user deposits `lamports` and is minted
   * liqSOL 1:1 (plus a pay-rate-derived fee minted to the distribution bucket).
   * The instruction creates the user's liqSOL ATA and distribution record on
   * first use, so no separate provisioning step is needed.
   *
   * @param actor - The narrative subject (the user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param userName - Durable handle of the user's persisted keypair.
   * @param lamports - Lamports to deposit.
   * @returns The definition step.
   */
  export function planDepositForLiqsol<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    userName: string,
    lamports: bigint,
    ephemeralStakeSeed: number = nextEphemeralStakeSeed(userName)
  ): ClusterBuildStep<C, DepositForLiqsolInput> {
    return ClusterBuildStep.create<C, DepositForLiqsolInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaLiqSyndicationTool.DepositForLiqsolInput",
        userName,
        lamports,
        ephemeralStakeSeed
      },
      runDepositForLiqsol
    )
  }

  /** Plan-order counter mixed into {@link nextEphemeralStakeSeed}. */
  let ephemeralStakeSeedOrdinal = 0

  /**
   * The next ephemeral-stake seed for `userName` — a `u32` derived from the
   * user's durable handle and a monotonic plan-order ordinal (FNV-1a), so two
   * deposits planned for the same user in one build get different stake
   * accounts. Drawn in the FACTORY so the value lands on the step input and
   * therefore in the Report.
   *
   * The ordinal is per-PROCESS, so the same plan built in a fresh process draws
   * the same seeds again. That is deliberate and safe: `sol_to_liqsol` merges
   * the ephemeral stake account into the vault within the instruction, so the
   * address is free again by the time any re-run reaches it — and a re-run
   * against a used cluster is refused earlier anyway, by the scenario's
   * pre-launch verify step.
   *
   * @param userName - The depositing user's durable keypair handle.
   * @returns A `u32` seed.
   */
  export function nextEphemeralStakeSeed(userName: string): number {
    ephemeralStakeSeedOrdinal += 1
    const source = `${userName}#${ephemeralStakeSeedOrdinal}`
    let hash = Fnv1aOffsetBasis
    for (let index = 0; index < source.length; index += 1) {
      hash = Math.imul(hash ^ source.charCodeAt(index), Fnv1aPrime)
    }
    return hash >>> 0
  }

  /** FNV-1a 32-bit offset basis (`nextEphemeralStakeSeed`). */
  const Fnv1aOffsetBasis = 0x811c9dc5
  /** FNV-1a 32-bit prime (`nextEphemeralStakeSeed`). */
  const Fnv1aPrime = 0x01000193

  /**
   * The runtime's `EpochRewards` sysvar.
   *
   * Solana distributes an epoch's staking rewards over the first blocks of the
   * NEXT epoch (SIMD-118, "partitioned epoch rewards") and REFUSES every stake
   * instruction while that runs. `liqsol_core` reads this same sysvar and fails
   * `deposit_to_reserve` fast with `EpochRewardsActive` rather than letting the
   * CPI blow up later, so a deposit submitted inside the window is rejected in
   * simulation and never lands.
   *
   * This matters here because the harness runs the validator at
   * `ClusterConfig`'s `solanaSlotsPerEpoch` slots per epoch: the window is only
   * a few slots, but it recurs every ~40 seconds, so a deposit that does not
   * wait it out is a coin flip on a long enough run.
   */
  export const EpochRewardsSysvar = new PublicKey(
    "SysvarEpochRewards1111111111111111111111111"
  )

  /**
   * Byte offset of `EpochRewards.active`, the one field read here. Ahead of it
   * sit `distribution_starting_block_height` (u64), `num_partitions` (u64),
   * `parent_blockhash` (32 bytes), `total_points` (u128), `total_rewards` (u64)
   * and `distributed_rewards` (u64).
   */
  export const EpochRewardsActiveOffset = 8 + 8 + 32 + 16 + 8 + 8

  /**
   * How long to wait for an epoch's reward distribution to finish. The window
   * is a handful of slots, so this is a generous ceiling on a wait that almost
   * always returns on its first poll.
   */
  export const EpochRewardsIdleBudgetMs = 120_000

  /** Poll cadence for {@link EpochRewardsIdleBudgetMs} — well under one slot. */
  export const EpochRewardsPollIntervalMs = 250

  /**
   * The program logs `@solana/web3.js` hangs off a failed submission —
   * `SendTransactionError` carries them, a plain `Error` does not.
   */
  interface ProgramLogCarrier {
    logs?: ReadonlyArray<string>
  }

  /**
   * `liqsol_core`'s error NAME for a stake op refused during the window.
   *
   * The name arm is the broad one: `StakeControllerError::EpochRewardsActive`
   * and `MergeError::EpochRewardsActive` are two different codes under this one
   * name, and both mean "the runtime is distributing rewards, try later".
   */
  export const EpochRewardsActiveErrorName = "EpochRewardsActive"

  /**
   * `StakeControllerError::EpochRewardsActive`'s Anchor error code.
   *
   * It comes from the enum's `#[error_code(offset = 7600)]` plus the variant's
   * index, NOT from the IDL: Anchor 0.31 emits every error at the default 6000
   * offset, so `target/idl/liqsol_core.json` prints 6021 for this variant until
   * wire-solana's `patch-idl-errors.js` rewrites it. 7621 is what the program
   * actually returns on chain.
   */
  export const EpochRewardsActiveErrorCode = 7621

  /**
   * The three shapes the refusal reaches this process as, derived from
   * {@link EpochRewardsActiveErrorCode} so they cannot drift from it:
   *
   * - the AnchorError name, in the program logs;
   * - `custom program error: 0x1dc5`, when preflight refuses the send;
   * - `{"InstructionError":[1,{"Custom":7621}]}`, when the tx PASSES preflight
   *   and fails on chain — the shape `confirmSignature` renders, and the one a
   *   deposit that lands inside the one-slot window actually produces.
   *
   * @returns The needles {@link isEpochRewardsActiveError} searches for.
   */
  export function epochRewardsActiveErrorNeedles(): ReadonlyArray<string> {
    return [
      EpochRewardsActiveErrorName,
      `0x${EpochRewardsActiveErrorCode.toString(16)}`,
      `"Custom":${EpochRewardsActiveErrorCode}`
    ]
  }

  /**
   * Whether `error` is the program refusing a stake operation because the
   * runtime is mid epoch-rewards distribution.
   *
   * A pure predicate over the error's rendered text: `SendTransactionError`
   * carries the program logs on `.logs` and folds them into `.message`, while
   * an on-chain failure arrives as `confirmSignature`'s JSON of the
   * transaction error. Every shape is matched, because the one that matters
   * most — the tx that passed preflight and executed inside the window —
   * carries neither the name nor the hex.
   *
   * @param error - The error a deposit submission rejected with.
   * @returns Whether it is the epoch-rewards refusal.
   */
  export function isEpochRewardsActiveError(error: Error): boolean {
    const { logs = [] } = error as ProgramLogCarrier,
      { message = "" } = error,
      text = [message, ...logs].join("\n")
    return epochRewardsActiveErrorNeedles().some(needle =>
      text.includes(needle)
    )
  }

  /**
   * Whether the runtime is currently distributing an epoch's staking rewards,
   * i.e. whether every stake instruction is currently refused. A READ — it runs
   * freely inside a runner.
   *
   * @param ctx - The build context (supplies the RPC connection).
   * @returns Whether {@link EpochRewardsSysvar}'s `active` flag is set.
   */
  export async function isEpochRewardsActive<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean> {
    const account = await ctx.solana.connection.getAccountInfo(
      EpochRewardsSysvar
    )
    // A runtime that predates partitioned rewards omits the sysvar entirely;
    // absent (or truncated) means nothing is being distributed.
    if (account == null || account.data.length <= EpochRewardsActiveOffset)
      return false
    return account.data[EpochRewardsActiveOffset] !== 0
  }

  /**
   * Block until the runtime is not distributing epoch rewards — the
   * precondition every stake-touching `liqsol_core` instruction is gated on.
   *
   * @param ctx - The build context (supplies the RPC connection).
   * @param label - What the caller is about to submit, for the timeout message.
   * @throws If rewards are still being distributed after
   *   {@link EpochRewardsIdleBudgetMs}.
   */
  export async function waitForEpochRewardsIdle<C extends ClusterBuildContext>(
    ctx: C,
    label: string
  ): Promise<void> {
    await pollUntil(
      `epoch rewards distribution to finish before ${label}`,
      async () => !(await isEpochRewardsActive(ctx)),
      EpochRewardsIdleBudgetMs,
      EpochRewardsPollIntervalMs
    )
  }

  /** Named runner — ONE `sol_to_liqsol` ix, signed by the user keypair. */
  export async function runDepositForLiqsol<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositForLiqsolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.lamports > 0n,
      "SolanaLiqSyndicationTool.planDepositForLiqsol: lamports must be positive"
    )
    const label = `SolanaLiqSyndicationTool.planDepositForLiqsol ${input.userName}`
    // `sol_to_liqsol` reaches `deposit_to_reserve`, the one stake-touching
    // instruction of the six this tool drives — so it is the one that has to
    // stand off the runtime's epoch-rewards window.
    await waitForEpochRewardsIdle(ctx, label)
    await submitWithEpochRewardsRetry(ctx, label, () =>
      sendDeposit(ctx, input, label)
    )
  }

  /**
   * Run `send`, and on the epoch-rewards refusal ONLY, wait the window out and
   * run it exactly once more.
   *
   * The caller's poll narrows the window to the gap between its last read and
   * the transaction landing; it cannot close it. The window is one slot per
   * epoch, so a second attempt after waiting it out is enough — and safe in
   * both shapes this error arrives in: a preflight refusal sent nothing, and an
   * on-chain failure is atomic. Any other error is the caller's and propagates
   * untouched, as does a second epoch-rewards failure.
   *
   * Takes `send` as a parameter so the retry is exercised without a validator.
   *
   * @param ctx - The build context (the wait reads the sysvar through it).
   * @param label - What is being submitted, for the log and the wait's timeout.
   * @param send - Builds and submits the transaction; called at most twice.
   */
  export async function submitWithEpochRewardsRetry<
    C extends ClusterBuildContext
  >(ctx: C, label: string, send: () => Promise<void>): Promise<void> {
    const outcome = await send().then(
      () => Either.right<Error, null>(null),
      (error: Error) => Either.left<Error, null>(error)
    )
    await outcome.match({
      Right: async () => undefined,
      Left: async error => {
        if (!isEpochRewardsActiveError(error)) throw error
        log.info(
          `${label}: the epoch-rewards window opened between the poll and the ` +
            "landing — waiting it out and re-sending once"
        )
        await waitForEpochRewardsIdle(ctx, label)
        await send()
      }
    })
  }

  /**
   * Build and submit ONE `sol_to_liqsol`. Separate from the runner so the
   * retry re-BUILDS the transaction (a fresh blockhash) rather than re-sending
   * a stale one; the ephemeral-stake seed rides the step input, so both
   * attempts address the same stake account.
   *
   * @param ctx - The build context.
   * @param input - The deposit step's input.
   * @param label - Confirmation label surfaced on timeout.
   */
  async function sendDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositForLiqsolInput,
    label: string
  ): Promise<void> {
    const user = SolanaFundingTool.loadKeypair(
        ctx.config.dataPath,
        input.userName
      ),
      pdas = deriveUserPdas(ctx.config.solanaPath, user.publicKey),
      program = loadLiqsolProgram(ctx, user),
      seed = input.ephemeralStakeSeed,
      ephemeralStake = await PublicKey.createWithSeed(
        user.publicKey,
        `${EphemeralStakeSeedPrefix}${seed}`,
        StakeProgram.programId
      ),
      transaction = await program.methods
        .solToLiqsol(new anchor.BN(input.lamports.toString()), seed)
        .accounts(depositForLiqsolAccounts(pdas, ephemeralStake))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({
            units: DepositComputeUnitLimit
          })
        ])
        .transaction()
    await submit(ctx, transaction, user, label)
  }

  // ── Step: launch-state flip (`liqsol_core::set_wire_state`) ──────────────

  /** Input for {@link planSetWireState} — one `set_wire_state` admin write. */
  export interface SetWireStateInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.SetWireStateInput"
    /** The launch state to move `GlobalState` to. */
    readonly wireState: WireState
  }

  /**
   * A single `set_wire_state` write, signed by the deployer (the liqsol
   * `global_config.admin`). The program only accepts the legal transitions, so
   * reaching `postLaunch` takes two steps — `launching`, then `postLaunch`.
   *
   * @param actor - The narrative subject (the Solana outpost admin).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param wireState - The launch state to move to.
   * @returns The definition step.
   */
  export function planSetWireState<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireState: WireState
  ): ClusterBuildStep<C, SetWireStateInput> {
    return ClusterBuildStep.create<C, SetWireStateInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaLiqSyndicationTool.SetWireStateInput", wireState },
      runSetWireState
    )
  }

  /** Named runner — ONE `set_wire_state` ix, signed by the deployer/admin. */
  export async function runSetWireState<C extends ClusterBuildContext>(
    ctx: C,
    input: SetWireStateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // Read the pre-state and refuse an impossible move HERE. `PostLaunch` is
    // terminal, so a second run of a scenario against the same cluster would
    // otherwise submit a transition the program reverts with
    // `InvalidWireState` — a revert that reads as a program fault when it is
    // really "this cluster is already past that point".
    const current = await readWireState(ctx)
    Assert.ok(
      current !== input.wireState,
      `SolanaLiqSyndicationTool.planSetWireState: the outpost is ALREADY in ${input.wireState} — ` +
        "this transition is a no-op on a fresh cluster and a re-run on a used one"
    )
    Assert.ok(
      canTransitionWireState(current, input.wireState),
      `SolanaLiqSyndicationTool.planSetWireState: liqsol_core does not allow ${current} -> ` +
        `${input.wireState} (permitted from ${current}: ` +
        `${WireStateTransitions[current].join(", ") || "nothing — it is terminal"})`
    )
    const admin = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      pdas = deriveBasePdas(ctx.config.solanaPath),
      program = loadLiqsolProgram(ctx, admin),
      transaction = await program.methods
        .setWireState(wireStateVariant(input.wireState))
        .accounts(setWireStateAccounts(pdas, admin.publicKey))
        .transaction()
    await submit(
      ctx,
      transaction,
      admin,
      `SolanaLiqSyndicationTool.planSetWireState ${input.wireState}`
    )
  }

  // ── Step: map the liq token code (`liqsol_core::set_token_address`) ──────

  /** Input for {@link planSetLiqTokenAddress} — one `set_token_address` admin write. */
  export interface SetLiqTokenAddressInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.SetLiqTokenAddressInput"
    /** SlugName-packed depot `token_code` the outpost's liqSOL mint registers under. */
    readonly tokenCode: bigint
  }

  /**
   * A single `set_token_address(tokenCode, liqsolMint)` write binding the REAL
   * liqSOL Token-2022 mint to the depot token code on the outpost's
   * `OutpostConfig`.
   *
   * Both `synd` and `report_liq_yield` denominate their attestation in a depot
   * TOKEN CODE resolved through `OutpostConfig::token_code_for_mint`, and refuse
   * with `LiqTokenNotMapped` when the liqSOL mint is absent from that map — so
   * this is a hard precondition of the syndication surface, not a convenience.
   *
   * @param actor - The narrative subject (the Solana outpost admin).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param tokenCode - SlugName-packed depot token code for the liq token.
   * @returns The definition step.
   */
  export function planSetLiqTokenAddress<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    tokenCode: bigint
  ): ClusterBuildStep<C, SetLiqTokenAddressInput> {
    return ClusterBuildStep.create<C, SetLiqTokenAddressInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaLiqSyndicationTool.SetLiqTokenAddressInput", tokenCode },
      runSetLiqTokenAddress
    )
  }

  /** Named runner — ONE `set_token_address` ix, signed by the deployer/admin. */
  export async function runSetLiqTokenAddress<C extends ClusterBuildContext>(
    ctx: C,
    input: SetLiqTokenAddressInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const admin = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      pdas = deriveBasePdas(ctx.config.solanaPath),
      program = loadLiqsolProgram(ctx, admin),
      transaction = await program.methods
        .setTokenAddress(
          new anchor.BN(input.tokenCode.toString()),
          pdas.liqsolMint
        )
        .accountsStrict(setLiqTokenAddressAccounts(pdas, admin.publicKey))
        .transaction()
    await submit(
      ctx,
      transaction,
      admin,
      `SolanaLiqSyndicationTool.planSetLiqTokenAddress ${input.tokenCode}`
    )
  }

  // ── Step: syndicate liqSOL (`liqsol_core::synd`) ─────────────────────────

  /** Input for {@link planSynd} — one user-signed `synd` write. */
  export interface SyndInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.SyndInput"
    /** Durable handle of the syndicating user's persisted keypair. */
    readonly userName: string
    /** liqSOL base units to syndicate into the outpost-owned pool. */
    readonly amount: bigint
  }

  /**
   * A single user-signed `synd` write. PostLaunch the syndicated liqSOL becomes
   * outpost property and the program queues a `SYNDICATE_LIQ` attestation on the
   * outbound message buffer — the depot becomes the ledger of record, so the
   * outpost keeps no per-user state and `outpost_account` is passed as `None`.
   *
   * @param actor - The narrative subject (the user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param userName - Durable handle of the user's persisted keypair.
   * @param amount - liqSOL base units to syndicate.
   * @returns The definition step.
   */
  export function planSynd<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    userName: string,
    amount: bigint
  ): ClusterBuildStep<C, SyndInput> {
    return ClusterBuildStep.create<C, SyndInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaLiqSyndicationTool.SyndInput", userName, amount },
      runSynd
    )
  }

  /** Named runner — ONE PostLaunch `synd` ix, signed by the user keypair. */
  export async function runSynd<C extends ClusterBuildContext>(
    ctx: C,
    input: SyndInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amount > 0n,
      "SolanaLiqSyndicationTool.planSynd: amount must be positive"
    )
    const user = SolanaFundingTool.loadKeypair(
        ctx.config.dataPath,
        input.userName
      ),
      pdas = deriveUserPdas(ctx.config.solanaPath, user.publicKey),
      program = loadLiqsolProgram(ctx, user),
      transaction = await program.methods
        .synd(new anchor.BN(input.amount.toString()))
        .accounts(syndAccounts(pdas))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({
            units: SyndicationComputeUnitLimit
          })
        ])
        .transaction()
    await submit(
      ctx,
      transaction,
      user,
      `SolanaLiqSyndicationTool.planSynd ${input.userName}`
    )
  }

  // ── Step: donate pool yield (`liqsol_core::inject_bonus_synd_yield`) ─────

  /** Input for {@link planInjectBonusSyndYield} — one permissionless donation write. */
  export interface InjectBonusSyndYieldInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.InjectBonusSyndYieldInput"
    /** Durable handle of the donor's persisted keypair (the donor pays the lamports). */
    readonly donorName: string
    /** Lamports donated — must be a positive multiple of {@link BonusYieldLamportGranularity}. */
    readonly lamports: bigint
  }

  /**
   * Granularity the program enforces on a bonus-yield donation (0.1 SOL). The
   * amount must be a positive multiple of it; anything else is refused on-chain.
   */
  export const BonusYieldLamportGranularity = 100_000_000n

  /**
   * A single permissionless `inject_bonus_synd_yield` write: the donor's
   * `lamports` move into the stake-controller reserve pool, the same number of
   * liqSOL base units is minted into the syndicated pool's ATA, and
   * `GlobalState::apply_yield` advances the yield index — exactly as a claimed
   * distribution reward would. The next `report_liq_yield` reports the delta.
   *
   * @param actor - The narrative subject (the donor).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param donorName - Durable handle of the donor's persisted keypair.
   * @param lamports - Lamports to donate (a multiple of {@link BonusYieldLamportGranularity}).
   * @returns The definition step.
   */
  export function planInjectBonusSyndYield<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    donorName: string,
    lamports: bigint
  ): ClusterBuildStep<C, InjectBonusSyndYieldInput> {
    return ClusterBuildStep.create<C, InjectBonusSyndYieldInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaLiqSyndicationTool.InjectBonusSyndYieldInput",
        donorName,
        lamports
      },
      runInjectBonusSyndYield
    )
  }

  /** Named runner — ONE `inject_bonus_synd_yield` ix, signed by the donor keypair. */
  export async function runInjectBonusSyndYield<C extends ClusterBuildContext>(
    ctx: C,
    input: InjectBonusSyndYieldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.lamports > 0n &&
        input.lamports % BonusYieldLamportGranularity === 0n,
      "SolanaLiqSyndicationTool.planInjectBonusSyndYield: lamports must be a positive " +
        `multiple of ${BonusYieldLamportGranularity}`
    )
    const donor = SolanaFundingTool.loadKeypair(
        ctx.config.dataPath,
        input.donorName
      ),
      pdas = deriveBasePdas(ctx.config.solanaPath),
      program = loadLiqsolProgram(ctx, donor),
      transaction = await program.methods
        .injectBonusSyndYield(new anchor.BN(input.lamports.toString()))
        .accounts(injectBonusSyndYieldAccounts(pdas, donor.publicKey))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({
            units: SyndicationComputeUnitLimit
          })
        ])
        .transaction()
    await submit(
      ctx,
      transaction,
      donor,
      `SolanaLiqSyndicationTool.planInjectBonusSyndYield ${input.donorName}`
    )
  }

  // ── Step: report pool yield (`liqsol_core::report_liq_yield`) ────────────

  /** Input for {@link planReportLiqYield} — one permissionless crank write. */
  export interface ReportLiqYieldInput extends StepInput {
    readonly kind: "SolanaLiqSyndicationTool.ReportLiqYieldInput"
    /** Durable handle of the cranker's persisted keypair (unconstrained signer). */
    readonly crankerName: string
  }

  /**
   * A single permissionless `report_liq_yield` crank. It claims the pool's
   * pending distribution rewards, then queues ONE `LIQ_YIELD` attestation for
   * the delta above the reported watermark and advances that watermark. With
   * nothing newly claimed it is an on-chain no-op that queues nothing and burns
   * no sequence number.
   *
   * @param actor - The narrative subject (the cranker).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param crankerName - Durable handle of the cranker's persisted keypair.
   * @returns The definition step.
   */
  export function planReportLiqYield<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    crankerName: string
  ): ClusterBuildStep<C, ReportLiqYieldInput> {
    return ClusterBuildStep.create<C, ReportLiqYieldInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaLiqSyndicationTool.ReportLiqYieldInput", crankerName },
      runReportLiqYield
    )
  }

  /** Named runner — ONE `report_liq_yield` ix, signed by the cranker keypair. */
  export async function runReportLiqYield<C extends ClusterBuildContext>(
    ctx: C,
    input: ReportLiqYieldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const cranker = SolanaFundingTool.loadKeypair(
        ctx.config.dataPath,
        input.crankerName
      ),
      pdas = deriveBasePdas(ctx.config.solanaPath),
      program = loadLiqsolProgram(ctx, cranker),
      transaction = await program.methods
        .reportLiqYield()
        .accountsStrict(reportLiqYieldAccounts(pdas, cranker.publicKey))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({
            units: SyndicationComputeUnitLimit
          })
        ])
        .transaction()
    await submit(
      ctx,
      transaction,
      cranker,
      `SolanaLiqSyndicationTool.planReportLiqYield ${input.crankerName}`
    )
  }
}
