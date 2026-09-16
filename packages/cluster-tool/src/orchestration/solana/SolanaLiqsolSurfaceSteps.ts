/**
 * SolanaLiqsolSurfaceSteps — the phase that stands up wire-solana's liqsol
 * surface on the cluster's validator, BEFORE the OPP outpost bootstrap.
 *
 * The validator loads all four wire-solana programs at genesis
 * (`SolanaValidatorProcessSteps.resolvePrograms`), but a loaded program owns no
 * accounts: the liqSOL mint, its transfer hook, the distribution / stake /
 * withdraw / wire-config state, the leaderboard and the reserve pool all come
 * from wire-solana's own `init-*` scripts (the tranche state deliberately does
 * NOT — see {@link InitScripts}). This phase runs each of
 * them as ONE {@link ClusterBuildStep} via {@link SolanaAnchorScriptTool}, in
 * the order `bash-scripts/reset-local-cluster.sh` uses.
 *
 * Sequencing matters twice:
 * - it runs BEFORE `SolanaOutpostSteps.planDeploy`, so `init-global-config`
 *   creates the liqsol `global_config` (admin = the deployer, proven against
 *   the program's `ProgramData`) and the outpost bootstrap's `ensureGlobalConfig`
 *   finds it already there;
 * - the deployer is airdropped FIRST, because it signs every one of these
 *   scripts (`--provider.wallet`) as well as the outpost bootstrap that follows.
 *
 * `reset-local-cluster.sh` itself is deliberately NOT used: its `anchor deploy`
 * would fight the genesis program load (a different upgrade authority), and its
 * mint-address rewrite no longer exists (the liqSOL mint is a PDA).
 */

import Assert from "node:assert"
import { execFile } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { promisify } from "node:util"

import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import {
  type AccountInfo,
  type EpochInfo,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction
} from "@solana/web3.js"

import { match } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { SolanaAnchorScriptTool } from "../../tools/solana/SolanaAnchorScriptTool.js"
import * as anchor from "@coral-xyz/anchor"

import { LiqsolPdaSeed } from "../../tools/solana/LiqsolPdaSeed.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { SolanaOutpostProgramTool } from "../../tools/solana/SolanaOutpostProgramTool.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"
import { pollUntil, verifyStep } from "../StepTools.js"
import { mapSeries } from "../../utils/asyncUtils.js"

const execFileAsync = promisify(execFile)

/** Steps that stand up the wire-solana liqsol surface on the cluster validator. */
export namespace SolanaLiqsolSurfaceSteps {
  /** The flag every pinned binary reports its version under. */
  export const VersionFlag = "--version"

  /** One wire-solana `Anchor.toml` `[scripts]` entry the liqsol surface needs. */
  export interface InitScript {
    /** The `Anchor.toml` `[scripts]` key — also the Report step name. */
    readonly script: string
    /** One-line description for the Report row. */
    readonly description: string
    /** Positional arguments forwarded to the script after `--`. */
    readonly args?: ReadonlyArray<string>
  }

  /**
   * Lamport FLOOR the treasury PDA is topped up to — the system-owned account
   * that sponsors every stake-account rent deposit (`WNS-26`). Matches
   * `reset-local-cluster.sh`'s local funding of 1 SOL; lowering it starves the
   * first `sol_to_liqsol` deposit of stake rent.
   */
  export const TreasuryFloorLamports = BigInt(LAMPORTS_PER_SOL)

  /**
   * PDA seed of `liqsol_core`'s SYSTEM-OWNED rent treasury (WNS-26) — the
   * account that floats every stake-account rent deposit. It has no init
   * instruction: it comes alive the moment lamports land in it, which is why
   * funding it is a plain `SystemProgram.transfer` and not a program call.
   */
  export const TreasurySeed = "treasury"

  /**
   * Lamport floor the deployer is topped up to before the init scripts run. It
   * pays for every init transaction, the treasury funding above, the outpost
   * bootstrap's SPL provisioning, and any flow that donates through it — sized
   * well clear of all of them so a run never stalls on deployer balance.
   */
  export const DeployerFloorLamports = BigInt(200 * LAMPORTS_PER_SOL)

  /**
   * The wire-solana init scripts, in the order `reset-local-cluster.sh` runs
   * them. The order is load-bearing at four points: the mint precedes its
   * transfer hook; the distribution state precedes `init-wire-config`, whose
   * instruction now creates the liqSOL pool's ATA and distribution record
   * itself and therefore reads both the mint and `distribution_state`;
   * `init-wire-config` precedes `init-global-config`, because that is what
   * opens deposits and the pool's accounting has to exist first (the
   * instruction refuses a non-empty bootstrap state outright); and the
   * stake-controller state precedes `global_config` too, whose admin gates the
   * leaderboard config. `init-wire-config` also still precedes the pretoken
   * history, which reads the `GlobalState` it creates.
   *
   * EVERY entry here is get-or-create AND exits non-zero on failure, which is
   * what {@link SolanaAnchorScriptTool} requires — a re-run against a
   * partially-initialized cluster is safe, and a failed write turns its Step
   * row red rather than passing it.
   *
   * Three of `reset-local-cluster.sh`'s steps are deliberately NOT here,
   * because each fails one of those two properties:
   *
   * - `fund-treasury` is an unconditional `SystemProgram.transfer` that
   *   re-funds on every replay → {@link planFundTreasury}, which reads the
   *   balance and transfers only the shortfall.
   * - `init-controller` writes `initialize_stake_controller_state` and
   *   `initialize_vault` unconditionally and ends in
   *   `main().catch(console.error)`, so a failed write prints and exits 0 →
   *   {@link planInitStakeControllerState} and {@link planInitVault}.
   * - `init-distro` has the same shape for the distribution `initialize` →
   *   {@link planInitDistribution}.
   *
   * The last two mattered in practice: `runScript` sees only the exit code, so
   * those Step rows could not go red, and a failed init surfaced steps later at
   * whoever first read `controllerState` or `distribution_state` — under the
   * wrong name.
   *
   * `init-pretoken-purchase-history` carries a dependency none of the others
   * do: it stores `current_epoch - 1`, and 0 is the program's "uninitialized"
   * sentinel, so it must not run before Solana epoch
   * {@link MinimumPretokenHistoryEpoch}. The phase waits for that epoch
   * immediately before it and reads the result back immediately after —
   * {@link assertPretokenHistoryEpochReached} and
   * {@link assertPretokenHistoryInitialized}. This is also what makes a
   * 100-slot epoch schedule sufficient: at agave's default the wait would be
   * days.
   *
   * `init-tranche-state` is the other omission, and for a harder reason: it
   * CANNOT run on a local cluster built from a deployable program. Outside
   * `--features development`, `initialize_tranche_state` pins its
   * `chainlink_feed` and `chainlink_program` accounts to the real mainnet
   * Chainlink SOL/USD feed and program by address, and a test validator hosts
   * neither — the script hands it the system program and the instruction
   * refuses with `InvalidChainlinkFeed` (7701). The tranche state is the
   * pretoken sale's price oracle: nothing on the syndication path reads it, and
   * neither does any later script here (`init-wire-config`,
   * `init-pretoken-purchase-history` and `init-reserve` name no tranche or
   * chainlink account), so the surface this harness needs is complete without
   * it. A cluster that DOES need the tranche state needs those two accounts
   * cloned onto its validator first, which is a wire-solana decision, not a
   * step this phase can take.
   */
  export const InitScripts: ReadonlyArray<InitScript> = [
    { script: "init-token-mint", description: "create the liqSOL Token-2022 mint + its mint authority" },
    { script: "init-transfer-hook", description: "create the liqSOL mint's ExtraAccountMetaList" },
    { script: "init-wire-config", description: "create the wire GlobalState + the liqSOL pool's ATA and distribution record" },
    { script: "init-global-config", description: "create the liqsol global_config (admin = the deployer)" },
    { script: "init-validators-active-list", description: "create the active-validator list" },
    { script: "init-validators-graveyard-list", description: "create the graveyard-validator list" },
    { script: "init-validator-leaderboard", description: "create + size the validator leaderboard" },
    { script: "init-leaderboard-config", description: "create the leaderboard config from global_config.admin" },
    { script: "init-allocation-state", description: "create the stake-allocation state" },
    { script: "init-stake-state", description: "create the global stake state" },
    { script: "init-liqsol-bucket", description: "create the liqSOL distribution-bucket token account" },
    { script: "init-pay-rate-history", description: "create the pay-rate history ring" },
    { script: "init-withdraw-global", description: "create the withdraw global state" },
    { script: "init-withdraw-metadata", description: "create the withdraw metadata" },
    { script: "init-pretoken-purchase-history", description: "create the pretoken purchase history" },
    { script: "init-reserve", description: "create the stake-controller reserve pool" }
  ]

  /**
   * The init script the distribution Step precedes — `reset-local-cluster.sh`
   * runs `init-distro` immediately before it, and `init_wire_config` reads the
   * `distribution_state` it creates.
   */
  export const WireConfigScript = "init-wire-config"

  /**
   * The init script the two stake-controller Steps precede — the position
   * `reset-local-cluster.sh` runs `init-controller` at.
   */
  export const GlobalConfigScript = "init-global-config"

  /** The init script the epoch gate precedes and the history read follows. */
  export const PretokenHistoryScript = "init-pretoken-purchase-history"

  /**
   * The harness Steps that must run immediately BEFORE `script`, keyed by the
   * script they guard rather than by index, so inserting an init script cannot
   * silently move them.
   *
   * @param script - The init script about to be planned.
   * @param options - Step tuning applied to the emitted Steps.
   * @returns The Steps to emit ahead of `script` (empty for most).
   */
  function planStepsBefore<C extends ClusterBuildContext>(
    script: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep.Any<C>[] {
    return match(script)
      .with(WireConfigScript, () => [
        planInitDistribution<C>(
          Report.Actor.SolanaOutpost,
          "init-distribution-state",
          "create DistributionState + the pool/bucket authorities",
          options
        )
      ])
      .with(GlobalConfigScript, () => [
        planInitStakeControllerState<C>(
          Report.Actor.SolanaOutpost,
          "init-stake-controller-state",
          "create the stake-controller state",
          options
        ),
        planInitVault<C>(
          Report.Actor.SolanaOutpost,
          "init-stake-vault",
          "create the stake-controller vault",
          options
        )
      ])
      .with(PretokenHistoryScript, () => [
        verifyStep<C>(
          Report.Actor.SolanaOutpost,
          "await-pretoken-history-epoch",
          `the validator has reached Solana epoch ${MinimumPretokenHistoryEpoch}, ` +
            "before which the history records its own uninitialized sentinel",
          assertPretokenHistoryEpochReached
        )
      ])
      .otherwise(() => [])
  }

  /**
   * The harness Steps that must run immediately AFTER `script`.
   *
   * @param script - The init script just planned.
   * @returns The Steps to emit after it (empty for most).
   */
  function planStepsAfter<C extends ClusterBuildContext>(
    script: string
  ): ClusterBuildStep.Any<C>[] {
    return match(script)
      .with(PretokenHistoryScript, () => [
        verifyStep<C>(
          Report.Actor.SolanaOutpost,
          "verify-pretoken-history",
          "the pretoken history the previous step created is one the program considers initialized",
          assertPretokenHistoryInitialized
        )
      ])
      .otherwise(() => [])
  }

  /**
   * Build the liqsol-surface phase: assert the loaded program ids match the
   * IDLs the `anchor run` scripts resolve from, airdrop the deployer, then run
   * every {@link InitScripts} entry as its own step. Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing group to register on.
   * @param name - Phase name (report node).
   * @param description - One-line phase description.
   * @param options - Per-step tuning applied to every init-script step.
   * @returns The registered phase.
   */
  export function planLiqsolSurface<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const steps: ClusterBuildStep.Any<C>[] = [
      verifyStep<C>(
        Report.Actor.SolanaOutpost,
        "verify-toolchain",
        "the installed solana + anchor are the versions Anchor.toml pins",
        assertToolchainMatchesPins
      ),
      verifyStep<C>(
        Report.Actor.SolanaOutpost,
        "verify-program-ids",
        "every wire-solana IDL declares the program id the validator loaded",
        assertProgramIdsMatch
      ),
      SolanaFundingTool.planKeypairAirdrop<C>(
        Report.Actor.SolanaOutpost,
        "airdrop-deployer",
        `top the SOL deployer up to ${DeployerFloorLamports} lamports`,
        options,
        SolanaFundingTool.DeployerKeypairName,
        DeployerFloorLamports
      ),
      ...InitScripts.flatMap(
        ({ script, description: scriptDescription, args }) => [
          ...planStepsBefore<C>(script, options),
          SolanaAnchorScriptTool.planRun<C>(
            Report.Actor.SolanaOutpost,
            script,
            scriptDescription,
            options,
            script,
            args ?? []
          ),
          ...planStepsAfter<C>(script)
        ]
      ),
      planFundTreasury<C>(
        Report.Actor.SolanaOutpost,
        "fund-treasury",
        `top the rent treasury up to ${TreasuryFloorLamports} lamports`,
        options,
        TreasuryFloorLamports
      )
    ]
    return ClusterBuildPhase.create<C>(parent, name, description, steps)
  }

  // ── Step: top up the rent treasury (one SystemProgram.transfer) ──────────

  /** Input for {@link planFundTreasury} — top the treasury PDA up to a floor. */
  export interface FundTreasuryInput extends StepInput {
    readonly kind: "SolanaLiqsolSurfaceSteps.FundTreasuryInput"
    /** Ensure the treasury PDA holds at least this many lamports. */
    readonly floorLamports: bigint
  }

  /**
   * A single `SystemProgram.transfer` that tops the `liqsol_core` rent treasury
   * up to `floorLamports`, paid by the deployer.
   *
   * This replaces wire-solana's `fund-treasury` script, which is an
   * UNCONDITIONAL transfer of its argument: driving it from the bootstrap would
   * move another whole SOL on every replay of the phase, and the rest of the
   * phase is get-or-create. Reading first and transferring only the shortfall
   * makes the whole phase re-runnable — the same shape as
   * {@link SolanaFundingTool.planKeypairAirdrop}. A treasury already at or
   * above the floor no-ops.
   *
   * @param actor - The narrative subject (the Solana outpost).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param floorLamports - The lamport floor to top the treasury up to.
   * @returns The definition step.
   */
  export function planFundTreasury<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    floorLamports: bigint
  ): ClusterBuildStep<C, FundTreasuryInput> {
    return ClusterBuildStep.create<C, FundTreasuryInput>(
      actor,
      name,
      description,
      options,
      { kind: "SolanaLiqsolSurfaceSteps.FundTreasuryInput", floorLamports },
      runFundTreasury
    )
  }

  /** Named runner — read the treasury balance (a read), then ONE transfer if below floor. */
  export async function runFundTreasury<C extends ClusterBuildContext>(
    ctx: C,
    input: FundTreasuryInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const deployer = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      treasury = treasuryAddress(ctx.config.solanaPath),
      current = BigInt(await ctx.solana.getLamports(treasury))
    if (current >= input.floorLamports) return
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: treasury,
        lamports: input.floorLamports - current
      })
    )
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [deployer],
      { skipPreflight: false }
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      "SolanaLiqsolSurfaceSteps.planFundTreasury"
    )
  }

  /**
   * The `liqsol_core` rent-treasury PDA. A pure value helper (no chain call),
   * so it is called freely inside runners.
   *
   * @param solanaPath - The `wire-solana` repo root (supplies the program id).
   * @returns The treasury address.
   */
  export function treasuryAddress(solanaPath: string): PublicKey {
    return SolanaOutpostProgramTool.derivePda(
      SolanaOutpostProgramTool.assertProgramId(
        solanaPath,
        SolanaOutpostProgramTool.AnchorProgram.liqsolCore
      ),
      Buffer.from(TreasurySeed)
    )
  }

  // ── Steps: the surface writes `reset-local-cluster.sh` cannot be trusted with ──

  /**
   * Input for the three liqsol-surface init Steps — each performs ONE
   * `liqsol_core` instruction, so the input names only which one.
   */
  export interface InitAccountInput extends StepInput {
    readonly kind: "SolanaLiqsolSurfaceSteps.InitAccountInput"
    /** The `liqsol_core` instruction this Step submits, camelCased. */
    readonly instruction: string
  }

  /** The `liqsol_core` instructions the three surface Steps submit. */
  export namespace InitInstruction {
    /** Creates the `distribution_state` the bucket + pool accounting hangs off. */
    export const Distribution = "initialize"
    /** Creates the `stake_controller` state. */
    export const StakeControllerState = "initializeStakeControllerState"
    /** Creates the stake-controller `vault`. */
    export const Vault = "initializeVault"
  }

  /**
   * Create the distribution state (`liqsol_core::initialize`) — the account
   * the bucket authority, the pool authority and every `user_record` hang off.
   *
   * @param actor - The narrative subject (the Solana outpost).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step tuning.
   * @returns The Step.
   */
  export function planInitDistribution<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, InitAccountInput> {
    return ClusterBuildStep.create<C, InitAccountInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaLiqsolSurfaceSteps.InitAccountInput",
        instruction: InitInstruction.Distribution
      },
      runInitDistribution
    )
  }

  /** Named runner — ONE `initialize`, skipped when `distribution_state` exists. */
  export async function runInitDistribution<C extends ClusterBuildContext>(
    ctx: C,
    input: InitAccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { deployer, program, pdas } = loadSurfaceWriter(ctx)
    if (await accountExists(ctx, pdas.distributionState)) return
    await submitSurfaceWrite(
      ctx,
      await program.methods[input.instruction]()
        .accounts({
          authority: deployer.publicKey,
          liqsolMint: pdas.liqsolMint,
          distributionState: pdas.distributionState,
          bucketAuthority: pdas.bucketAuthority,
          poolAuthority: pdas.poolAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY
        })
        .transaction(),
      deployer,
      input.instruction
    )
  }

  /**
   * Create the stake-controller state
   * (`liqsol_core::initialize_stake_controller_state`).
   *
   * @param actor - The narrative subject (the Solana outpost).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step tuning.
   * @returns The Step.
   */
  export function planInitStakeControllerState<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, InitAccountInput> {
    return ClusterBuildStep.create<C, InitAccountInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaLiqsolSurfaceSteps.InitAccountInput",
        instruction: InitInstruction.StakeControllerState
      },
      runInitStakeControllerState
    )
  }

  /** Named runner — ONE `initialize_stake_controller_state`, skipped when it exists. */
  export async function runInitStakeControllerState<
    C extends ClusterBuildContext
  >(ctx: C, input: InitAccountInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { deployer, program, pdas } = loadSurfaceWriter(ctx)
    if (await accountExists(ctx, pdas.stakeControllerState)) return
    await submitSurfaceWrite(
      ctx,
      await program.methods[input.instruction]()
        .accounts({
          controllerState: pdas.stakeControllerState,
          payer: deployer.publicKey,
          authority: deployer.publicKey,
          systemProgram: SystemProgram.programId
        })
        .transaction(),
      deployer,
      input.instruction
    )
  }

  /**
   * Create the stake-controller vault (`liqsol_core::initialize_vault`) — the
   * account every `sol_to_liqsol` deposit lands its stake in.
   *
   * @param actor - The narrative subject (the Solana outpost).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step tuning.
   * @returns The Step.
   */
  export function planInitVault<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, InitAccountInput> {
    return ClusterBuildStep.create<C, InitAccountInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SolanaLiqsolSurfaceSteps.InitAccountInput",
        instruction: InitInstruction.Vault
      },
      runInitVault
    )
  }

  /** Named runner — ONE `initialize_vault`, skipped when the vault exists. */
  export async function runInitVault<C extends ClusterBuildContext>(
    ctx: C,
    input: InitAccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { deployer, program, pdas } = loadSurfaceWriter(ctx)
    if (await accountExists(ctx, pdas.vault)) return
    await submitSurfaceWrite(
      ctx,
      await program.methods[input.instruction]()
        .accounts({
          vault: pdas.vault,
          payer: deployer.publicKey,
          controllerState: pdas.stakeControllerState,
          systemProgram: SystemProgram.programId
        })
        .transaction(),
      deployer,
      input.instruction
    )
  }

  /** The accounts the three surface init Steps create or reference. */
  export interface SurfaceAccounts {
    /** `liqsol_core` — the distribution state (yield index + bucket accounting). */
    distributionState: PublicKey
    /** `liqsol_core` — the distribution-bucket authority. */
    bucketAuthority: PublicKey
    /** `liqsol_core` — the syndicated-pool authority. */
    poolAuthority: PublicKey
    /** `liqsol_core` — the stake-controller state. */
    stakeControllerState: PublicKey
    /** `liqsol_core` — the stake-controller vault. */
    vault: PublicKey
    /** `liqsol_token` — the liqSOL Token-2022 mint. */
    liqsolMint: PublicKey
  }

  /**
   * Derive the accounts the surface init Steps address, from the ONE seed
   * registry ({@link LiqsolPdaSeed}). A pure value helper (no chain call).
   *
   * @param solanaPath - The `wire-solana` repo root.
   * @returns The derived addresses.
   */
  export function surfaceAccounts(solanaPath: string): SurfaceAccounts {
    const core = SolanaOutpostProgramTool.assertProgramId(
        solanaPath,
        SolanaOutpostProgramTool.AnchorProgram.liqsolCore
      ),
      token = SolanaOutpostProgramTool.assertProgramId(
        solanaPath,
        SolanaOutpostProgramTool.AnchorProgram.liqsolToken
      ),
      derive = (programId: PublicKey, seed: string) =>
        SolanaOutpostProgramTool.derivePda(programId, Buffer.from(seed))
    return {
      distributionState: derive(core, LiqsolPdaSeed.DistributionState),
      bucketAuthority: derive(core, LiqsolPdaSeed.BucketAuthority),
      poolAuthority: derive(core, LiqsolPdaSeed.PoolAuthority),
      stakeControllerState: derive(core, LiqsolPdaSeed.StakeControllerState),
      vault: derive(core, LiqsolPdaSeed.Vault),
      liqsolMint: derive(token, LiqsolPdaSeed.LiqsolMint)
    }
  }

  /** What a surface init runner resolves from `ctx` before it writes. */
  interface SurfaceWriter {
    deployer: Keypair
    program: anchor.Program<anchor.Idl>
    pdas: SurfaceAccounts
  }

  /**
   * The deployer, the `liqsol_core` program bound to it, and the surface
   * accounts — everything the three init runners above resolve from `ctx`. A
   * pure value helper (no chain call).
   *
   * @param ctx - The build context.
   * @returns The signer, its program handle and the derived addresses.
   */
  function loadSurfaceWriter<C extends ClusterBuildContext>(
    ctx: C
  ): SurfaceWriter {
    const deployer = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath)
    return {
      deployer,
      program: SolanaOutpostProgramTool.loadProgram(
        ctx.solana.connection,
        deployer,
        ctx.config.solanaPath
      ),
      pdas: surfaceAccounts(ctx.config.solanaPath)
    }
  }

  /**
   * Whether `address` already holds an account — the get-or-create read every
   * surface init Step makes before it writes.
   *
   * @param ctx - The build context (supplies the RPC connection).
   * @param address - The PDA to probe.
   * @returns Whether the account exists.
   */
  async function accountExists<C extends ClusterBuildContext>(
    ctx: C,
    address: PublicKey
  ): Promise<boolean> {
    return (await ctx.solana.connection.getAccountInfo(address)) != null
  }

  /**
   * Submit one surface-init transaction and wait for its confirmation.
   *
   * @param ctx - The build context (supplies the recording connection).
   * @param transaction - The built, unsigned transaction.
   * @param signer - The deployer, which signs and pays.
   * @param instruction - The instruction name, for the confirmation label.
   */
  async function submitSurfaceWrite<C extends ClusterBuildContext>(
    ctx: C,
    transaction: Transaction,
    signer: Keypair,
    instruction: string
  ): Promise<void> {
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [signer],
      { skipPreflight: false }
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `SolanaLiqsolSurfaceSteps.${instruction}`
    )
  }

  /**
   * Verify body — each program's generated IDL `address` equals the id derived
   * from its committed `.keys` keypair (the address the validator loaded the
   * `.so` at).
   *
   * `anchor run`'s scripts resolve their program from the IDL, while the
   * validator loaded the `.so` at the `.keys` id; CI runs
   * `bash-scripts/prep-anchor-toml.sh` to keep the two aligned and a developer
   * does it by hand, so a mismatch means a stale artifact — and it would
   * otherwise surface far away, as an init script transacting against an
   * address with no program at it.
   *
   * @param ctx - The build context (supplies `solanaPath`).
   */
  export async function assertProgramIdsMatch<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<void> {
    const { solanaPath } = ctx.config
    SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program => {
      const loaded = SolanaOutpostProgramTool.assertProgramId(
          solanaPath,
          program
        ),
        declared = SolanaOutpostProgramTool.assertIdlProgramId(
          solanaPath,
          program
        )
      Assert.ok(
        loaded.equals(declared),
        `SolanaLiqsolSurfaceSteps: ${program} IDL declares ${declared.toBase58()} but the ` +
          `committed keypair is ${loaded.toBase58()} — the validator loaded the keypair id, so ` +
          `every 'anchor run' script would transact against the wrong address. Re-run ` +
          `'bash-scripts/prep-anchor-toml.sh' then 'anchor build' in wire-solana.`
      )
    })
  }

  // ── the Solana-epoch gate `init-pretoken-purchase-history` depends on ──

  /**
   * Earliest Solana epoch `initialize_pretoken_purchase_history` may run in.
   *
   * The instruction stores `starting_epoch = current_epoch - 1`, and
   * `PretokenPurchaseHistory::is_initialized()` IS `starting_epoch != 0`. So
   * the write is wrong in two epochs and only two: in epoch 0 it underflows
   * (`Underflow`, 7418) and the script exits 1; in epoch 1 it SUCCEEDS and
   * stores 0 — the program's own "never initialized" sentinel — after which
   * every pre-launch syndication, pretoken and refund path on that cluster
   * fails `InvalidWireState` forever.
   *
   * 2 is wire-solana's own gate, for the same reason and with the same
   * reasoning written out: `bash-scripts/wait-for-validators.sh` (`MIN_EPOCH`,
   * default 2, under "WHY the epoch gate").
   */
  export const MinimumPretokenHistoryEpoch = 2

  /** Poll cadence for the epoch gate — far below one slot. */
  export const EpochPollIntervalMs = 250

  /**
   * agave's target slot time (ms). The epoch wait's budget is derived from it
   * and `ClusterConfig.solanaSlotsPerEpoch` rather than measured, per
   * STYLE.md "Timing Budgets": the poll returns the moment the epoch turns, so
   * a generous ceiling costs a healthy run nothing.
   */
  export const SlotDurationMs = 400

  /**
   * How much slower than agave's target the validator may run and still make
   * the gate's deadline. The budget is the slot time actually REMAINING, so
   * this is the whole tolerance — at 2 a validator producing slots at half
   * speed still arrives in time.
   */
  export const PretokenHistoryEpochBudgetSlack = 2

  /**
   * Wall-clock ceiling for the epoch gate, from where the validator IS.
   *
   * Derived from the live epoch position rather than from a whole number of
   * epochs: by the time this runs, ~15 init scripts have already consumed most
   * of the wait, so a budget counted from the step's start would be mostly
   * slack in the normal case and still too tight for a slow validator in the
   * bad one. `slotsInEpoch - slotIndex` is the exact remainder of the current
   * epoch; whole epochs are added for any that follow.
   *
   * A pure value helper over the epoch info, so the budget is testable without
   * a validator.
   *
   * @param epoch - What `getEpochInfo()` reported.
   * @returns The deadline in milliseconds (0 when the epoch is already reached).
   */
  export function pretokenHistoryEpochBudgetMs(epoch: EpochInfo): number {
    if (epoch.epoch >= MinimumPretokenHistoryEpoch) return 0
    const remainingInCurrent = epoch.slotsInEpoch - epoch.slotIndex,
      wholeEpochsAfter = MinimumPretokenHistoryEpoch - epoch.epoch - 1,
      slots = remainingInCurrent + wholeEpochsAfter * epoch.slotsInEpoch
    return slots * SlotDurationMs * PretokenHistoryEpochBudgetSlack
  }

  /**
   * Verify body — block until the validator has reached
   * {@link MinimumPretokenHistoryEpoch}.
   *
   * A READ, and the only thing standing between a fast host and a cluster
   * whose pretoken history is poisoned for its whole life. It sits immediately
   * before `init-pretoken-purchase-history` rather than at the head of the
   * phase because the ~15 scripts ahead of it already absorb most of the wait.
   *
   * @param ctx - The build context (supplies the RPC connection).
   * @throws If the epoch is not reached within
   *   {@link pretokenHistoryEpochBudgetMs}.
   */
  export async function assertPretokenHistoryEpochReached<
    C extends ClusterBuildContext
  >(ctx: C): Promise<void> {
    const started = await ctx.solana.connection.getEpochInfo()
    // Already there: the scripts ahead of this step usually spend the wait, so
    // this is the common case and it costs one RPC read.
    if (started.epoch >= MinimumPretokenHistoryEpoch) return
    await pollUntil(
      `the validator to reach Solana epoch ${MinimumPretokenHistoryEpoch} — ` +
        "initialize_pretoken_purchase_history stores current_epoch - 1, and 0 is " +
        "the program's 'uninitialized' sentinel",
      async () =>
        (await ctx.solana.connection.getEpochInfo()).epoch >=
        MinimumPretokenHistoryEpoch,
      pretokenHistoryEpochBudgetMs(started),
      EpochPollIntervalMs
    )
  }

  /** The `PretokenPurchaseHistory` account name in the camelCased coder. */
  export const PretokenPurchaseHistoryAccountName = "pretokenPurchaseHistory"

  /**
   * Slots the read-back waits for the history to become visible.
   *
   * The script ahead of it confirms its `.rpc()` at the provider's default
   * commitment, which `AnchorProvider.env()` sets to `processed`, while this
   * connection reads at `confirmed` — at least one slot behind. Both runs so
   * far cleared it on ts-node teardown slack alone (~3 slots); on a starved
   * runner that margin is not there, and a `null` read would fail the whole
   * bootstrap claiming the script created nothing.
   */
  export const PretokenHistoryVisibilitySlots = 8

  /** Poll cadence for the visibility wait — several checks per slot. */
  export const PretokenHistoryVisibilityPollMs = 100

  /**
   * Wall-clock ceiling for the history to become visible at this connection's
   * commitment. A pure value helper.
   *
   * @returns The deadline in milliseconds.
   */
  export function pretokenHistoryVisibilityBudgetMs(): number {
    return PretokenHistoryVisibilitySlots * SlotDurationMs
  }

  /** The one `PretokenPurchaseHistory` field the bootstrap reads back. */
  interface PretokenPurchaseHistoryAccount {
    startingEpoch: number
  }

  /**
   * Verify body — the history the previous step created is one the program
   * considers INITIALIZED, i.e. its `starting_epoch` is not the 0 sentinel.
   *
   * This is the assertion {@link assertPretokenHistoryEpochReached} exists to
   * make true. It is cheap, and without it a regression in the gate would
   * produce a cluster that looks healthy until the first pre-launch
   * syndication — several flows away — fails `InvalidWireState`.
   *
   * @param ctx - The build context (RPC connection + `solanaPath`).
   * @throws If the account is missing or carries the sentinel.
   */
  export async function assertPretokenHistoryInitialized<
    C extends ClusterBuildContext
  >(ctx: C): Promise<void> {
    const { solanaPath } = ctx.config,
      programId = SolanaOutpostProgramTool.assertProgramId(
        solanaPath,
        SolanaOutpostProgramTool.AnchorProgram.liqsolCore
      ),
      { poolAuthority } = surfaceAccounts(solanaPath),
      history = SolanaOutpostProgramTool.derivePda(
        programId,
        Buffer.from(LiqsolPdaSeed.PretokenPurchaseHistory),
        poolAuthority.toBuffer()
      ),
      // The WAIT is for visibility only — the script confirmed at `processed`
      // and this connection reads at `confirmed`. The sentinel assertion below
      // stays immediate: once the account is readable, its value is final.
      account = await pollForAccount(ctx, history)
    const { startingEpoch } =
      SolanaOutpostProgramTool.loadReadOnlyProgram(
        ctx.solana.connection,
        solanaPath
      ).coder.accounts.decode<PretokenPurchaseHistoryAccount>(
        PretokenPurchaseHistoryAccountName,
        account.data
      )
    Assert.ok(
      startingEpoch !== 0,
      `SolanaLiqsolSurfaceSteps: PretokenPurchaseHistory.starting_epoch is 0 — the program ` +
        "reads that as NEVER INITIALIZED, so every pre-launch syndication, pretoken and " +
        "refund path on this cluster will fail InvalidWireState for its whole life. It means " +
        `the history was written before Solana epoch ${MinimumPretokenHistoryEpoch}; destroy ` +
        "the cluster and create it again."
    )
  }

  /**
   * Read `address` once it is visible at this connection's commitment.
   *
   * @param ctx - The build context (supplies the RPC connection).
   * @param address - The account to read.
   * @returns The account, once it exists.
   * @throws If it has not appeared within
   *   {@link pretokenHistoryVisibilityBudgetMs}.
   */
  async function pollForAccount<C extends ClusterBuildContext>(
    ctx: C,
    address: PublicKey
  ): Promise<AccountInfo<Buffer>> {
    let account: AccountInfo<Buffer>
    await pollUntil(
      `PretokenPurchaseHistory ${address.toBase58()} to be readable — ` +
        "'init-pretoken-purchase-history' reported success, so if it never " +
        "appears the script created nothing",
      async () => {
        account = await ctx.solana.connection.getAccountInfo(address)
        return account != null
      },
      pretokenHistoryVisibilityBudgetMs(),
      PretokenHistoryVisibilityPollMs
    )
    return account
  }

  /**
   * `Anchor.toml`'s `[toolchain]` file name, read for the version pins below.
   */
  export const AnchorManifestFile = "Anchor.toml"

  /**
   * The `[toolchain]` keys that pin a host binary, mapped to the command whose
   * `--version` output has to satisfy them.
   */
  export const ToolchainPins: ReadonlyArray<ToolchainPin> = [
    { key: "solana_version", command: "solana" },
    { key: "anchor_version", command: "anchor" }
  ]

  /** One `[toolchain]` pin and the binary it constrains. */
  export interface ToolchainPin {
    /** The `Anchor.toml` `[toolchain]` key. */
    readonly key: string
    /** The binary whose `--version` must report the pinned version. */
    readonly command: string
  }

  /**
   * The version `Anchor.toml` pins for `key`, or `""` when it pins none — a
   * pure value helper over the manifest text, so the parse is unit-testable
   * without a wire-solana checkout.
   *
   * Deliberately a targeted read rather than a TOML parse: two scalar keys in a
   * known table are all this guard needs, and a parser dependency would be the
   * larger commitment.
   *
   * @param manifest - The `Anchor.toml` contents.
   * @param key - The `[toolchain]` key to read.
   * @returns The pinned version, or `""`.
   */
  export function toolchainPin(manifest: string, key: string): string {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(
      manifest
    )
    return match ? match[1] : ""
  }

  /**
   * Whether `output` (a `--version` line) reports `version`.
   *
   * `solana --version` prints `solana-cli 4.2.0 (src:…)` and `anchor --version`
   * prints `anchor-cli 0.31.0`, so the check is "is the pinned version one of
   * the whitespace-separated tokens" rather than an equality on the whole line.
   *
   * @param output - The binary's `--version` output.
   * @param version - The pinned version.
   * @returns Whether the output reports that version.
   */
  export function versionOutputMatches(
    output: string,
    version: string
  ): boolean {
    return output.trim().split(/\s+/).includes(version)
  }

  /**
   * Verify body — the installed `solana` and `anchor` are the versions
   * wire-solana's `Anchor.toml` `[toolchain]` pins.
   *
   * This is not hygiene. Since anchor-cli 0.30, `[toolchain]` is applied on
   * EVERY `anchor` invocation: a mismatch makes each of this phase's script
   * Steps run `agave-install init <pinned>` first — a network download that
   * repoints `~/.local/share/solana/install/active_release` while THIS
   * cluster's `solana-test-validator` is running out of it, then repoints it
   * back afterwards. The failure that produces is a validator that dies or
   * misbehaves mid-bootstrap, attributed to whatever step was unlucky. Refusing
   * up front costs one `--version` call per binary.
   *
   * @param ctx - The build context (supplies `solanaPath`).
   * @throws If a pin is absent, unreadable, or not what is installed.
   */
  export async function assertToolchainMatchesPins<
    C extends ClusterBuildContext
  >(ctx: C): Promise<void> {
    const manifestFile = Path.join(ctx.config.solanaPath, AnchorManifestFile)
    Assert.ok(
      Fs.existsSync(manifestFile),
      `SolanaLiqsolSurfaceSteps: ${manifestFile} is missing — ` +
        `--solana-path must point at a wire-solana checkout.`
    )
    const manifest = Fs.readFileSync(manifestFile, "utf8")
    await mapSeries(ToolchainPins, async ({ key, command }) => {
      const pinned = toolchainPin(manifest, key)
      Assert.ok(
        pinned.length > 0,
        `SolanaLiqsolSurfaceSteps: ${manifestFile} pins no [toolchain] ${key}.`
      )
      const { stdout } = await execFileAsync(command, [VersionFlag], {
        // The probe runs in exactly the context `anchor run` will: `anchor` is
        // an avm shim, and a future avm that resolves `[toolchain]` from the
        // cwd's Anchor.toml would otherwise report the DEFAULT version here and
        // the pinned one there.
        cwd: ctx.config.solanaPath
      }).catch(
        error => {
          throw new NestedError(
            `SolanaLiqsolSurfaceSteps: could not run '${command} ${VersionFlag}'`,
            { cause: error, context: { command, pinned } }
          )
        }
      )
      Assert.ok(
        versionOutputMatches(stdout, pinned),
        `SolanaLiqsolSurfaceSteps: ${manifestFile} pins ${key} = ${pinned}, but ` +
          `'${command} ${VersionFlag}' reports ${stdout.trim()}. anchor-cli applies ` +
          `[toolchain] on every invocation, so each init script would reinstall the ` +
          `toolchain underneath this cluster's running validator. Install ${pinned} ` +
          `(agave-install init ${pinned} / avm use ${pinned}) before creating a cluster.`
      )
    })
  }
}
