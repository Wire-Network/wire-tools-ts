import Assert from "node:assert/strict"
import { execFile } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { promisify } from "node:util"

import * as anchor from "@coral-xyz/anchor"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token"
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type Commitment
} from "@solana/web3.js"
import { match } from "ts-pattern"

import {
  ClusterBuildStep,
  LiqsolPdaSeed,
  Report,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState,
  confirmSignature,
  outputKey,
  pollUntil,
  scaleTimeoutMs,
  type ClusterBuildContext,
  type OutputKey,
  type StepInput
} from "@wireio/cluster-tool"

import { SolanaGenesisSnapshotConstants as Constants } from "./SolanaGenesisSnapshotConstants.js"
import {
  SolanaGenesisSnapshotSchema,
  type SolanaGenesisSnapshot
} from "./SolanaGenesisSnapshotSchema.js"

const execFileAsync = promisify(execFile)

/** Real prelaunch transactions and the external exporter invocation, one per Report Step. */
export namespace SolanaGenesisSteps {
  /** Instruction names, as Anchor exposes them; every invocation below submits just one. */
  export enum Instruction {
    initTrancheState = "initTrancheState",
    synd = "synd",
    purchase = "purchase",
    purchaseFromYield = "purchaseFromYield",
    desynd = "desynd",
    finalizeOutpostAccount = "finalizeOutpostAccount"
  }

  /** Additional pretoken PDA seeds, which the postlaunch syndication tool does not consume. */
  export const TrancheStateSeed = "tranche_state"
  export const UserPretokenRecordSeed = "user_pretoken_record"
  /** Artifact contract produced by the actual capital-index command. */
  export const FirstSnapshotKey = outputKey<SolanaGenesisSnapshot>(
    "solana-genesis:first-snapshot",
    "Immediate capital-index Launching export"
  )
  export const LaterSnapshotKey = outputKey<SolanaGenesisSnapshot>(
    "solana-genesis:later-snapshot",
    "Capital-index export in a later finalized epoch"
  )
  /** Fixture observations are transported through ctx, never captured by planned closures. */
  export const FixtureKey = outputKey<Fixture>(
    "solana-genesis:fixture",
    "Controlled prelaunch wallet positions"
  )
  export const RoundsKey = outputKey<YieldRound[]>(
    "solana-genesis:yield-rounds",
    "Observed real pool purchase deltas"
  )

  /** The actual prelaunch position, decoded using wire-solana's IDL rather than indexer offsets. */
  export interface Position {
    stakedLiqsol: anchor.BN
    stakedShares: anchor.BN
    purchasedLiqsol: anchor.BN
    purchasedShares: anchor.BN
    accumulatedPretokenYield: anchor.BN
  }

  /** The empty syndicated book expected on a fresh scenario cluster. */
  export interface PreLaunchTotals {
    totalStakedLiqsol: anchor.BN
    totalPurchasedLiqsol: anchor.BN
    totalShares: anchor.BN
  }

  /** Recorded direct/pool purchases, independently read through Anchor. */
  export interface PretokenRecord {
    totalSolDeposited: anchor.BN
    totalPretokensPurchased: anchor.BN
  }
  /** History is read only to prove which epoch the real purchase recorded. */
  export interface History {
    latestEpoch: anchor.BN
    startingEpoch: anchor.BN
    syndPerEpoch: anchor.BN[]
  }

  /** Anchor's tagged unit enum on the GlobalState account. */
  interface GlobalLaunchState {
    wireState: Record<string, object>
  }
  /** Controlled user position, captured before any rewards or full withdrawal. */
  export interface FixtureUser {
    address: string
    principal: bigint
    purchased: bigint
    directPretokens: bigint
    stakedShares: bigint
    purchasedShares: bigint
  }
  /** Both funded users and the epoch after their positions became stable. */
  export interface Fixture {
    active: FixtureUser
    exited: FixtureUser
    readyEpoch: number
  }
  /** Pool purchase delta and its purchase epoch; fixed principal ratios are the independent oracle. */
  export interface YieldRound {
    purchasedPretokens: bigint
    purchaseEpoch: number
  }

  /** Derive the existing surface's addresses plus the real pretoken record/history addresses.
   * @param ctx - Cluster context.
   * @param user - The wallet whose position is addressed.
   * @returns Canonical addresses for the transaction/account reads.
   */
  export function addresses(ctx: ClusterBuildContext, user: PublicKey) {
    const base = SolanaLiqSyndicationTool.deriveUserPdas(
      ctx.config.solanaPath,
      user
    )
    const derive = (seed: string, extra?: PublicKey) =>
      SolanaOutpostProgramTool.derivePda(
        base.liqsolCoreProgram,
        Buffer.from(seed),
        ...(extra ? [extra.toBuffer()] : [])
      )
    return {
      ...base,
      trancheState: derive(TrancheStateSeed),
      pretokenPurchaseHistory: derive(
        LiqsolPdaSeed.PretokenPurchaseHistory,
        base.poolAuthority
      ),
      userPretokenRecord: derive(UserPretokenRecordSeed, user),
      poolPretokenRecord: derive(UserPretokenRecordSeed, base.poolAuthority)
    }
  }

  /** Exact account maps for the six real prelaunch instructions.
   * @param instruction - Anchor instruction to execute.
   * @param pdas - Canonical addresses for its signer.
   * @returns The map passed directly to accountsStrict.
   */
  export function instructionAccounts(
    instruction: Instruction,
    pdas: ReturnType<typeof addresses>
  ): SolanaLiqSyndicationTool.InstructionAccounts {
    const shared = {
      user: pdas.user,
      liqsolMint: pdas.liqsolMint,
      globalState: pdas.globalState,
      distributionState: pdas.distributionState,
      poolAuthority: pdas.poolAuthority,
      bucketAuthority: pdas.bucketAuthority,
      bucketTokenAccount: pdas.bucketTokenAccount,
      bucketUserRecord: pdas.bucketUserRecord,
      extraAccountMetaList: pdas.extraAccountMetaList,
      liqsolCoreProgram: pdas.liqsolCoreProgram,
      transferHookProgram: pdas.transferHookProgram,
      liqsolPoolAta: pdas.liqsolPoolAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      pretokenPurchaseHistory: pdas.pretokenPurchaseHistory
    }
    return match(instruction)
      .with(Instruction.initTrancheState, () => ({
        authority: pdas.user,
        trancheState: pdas.trancheState,
        chainlinkFeed: SystemProgram.programId,
        chainlinkProgram: SystemProgram.programId,
        systemProgram: SystemProgram.programId
      }))
      .with(Instruction.synd, () => ({
        ...SolanaLiqSyndicationTool.syndAccounts(pdas),
        outpostAccount: pdas.outpostAccount,
        pretokenPurchaseHistory: pdas.pretokenPurchaseHistory,
        outboundMessageBuffer: null,
        config: null
      }))
      .with(Instruction.purchase, () => ({
        ...shared,
        buyerAta: pdas.userAta,
        senderUserRecord: pdas.userUserRecord,
        receiverUserRecord: pdas.liqsolPoolUserRecord,
        outpostAccount: pdas.outpostAccount,
        trancheState: pdas.trancheState,
        userPretokenRecord: pdas.userPretokenRecord,
        chainlinkFeed: SystemProgram.programId,
        chainlinkProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID
      }))
      .with(Instruction.purchaseFromYield, () => ({
        ...shared,
        liqsolPoolUserRecord: pdas.liqsolPoolUserRecord,
        trancheState: pdas.trancheState,
        poolPretokenRecord: pdas.poolPretokenRecord,
        chainlinkFeed: SystemProgram.programId,
        chainlinkProgram: SystemProgram.programId
      }))
      .with(Instruction.desynd, () => ({
        ...shared,
        userAta: pdas.userAta,
        senderUserRecord: pdas.liqsolPoolUserRecord,
        receiverUserRecord: pdas.userUserRecord,
        outpostAccount: pdas.outpostAccount,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID
      }))
      .with(Instruction.finalizeOutpostAccount, () => ({
        payer: pdas.user,
        user: pdas.user,
        globalState: pdas.globalState,
        poolAuthority: pdas.poolAuthority,
        outpostAccount: pdas.outpostAccount,
        pretokenPurchaseHistory: pdas.pretokenPurchaseHistory,
        systemProgram: SystemProgram.programId
      }))
      .exhaustive()
  }

  /** One instruction's typed Report input. */
  export interface WriteInput extends StepInput {
    kind: "SolanaGenesisSteps.WriteInput"
    instruction: Instruction
    userName: string
    amount: bigint
  }

  /** Plan exactly one real prelaunch transaction.
   * @param actor - Report actor.
   * @param name - Step name.
   * @param instruction - Actual Anchor method.
   * @param userName - Persisted signer label.
   * @param amount - liqSOL base units, or zero for argumentless instructions.
   * @returns A named transaction Step.
   */
  export function planWrite(
    actor: Report.Actor,
    name: string,
    instruction: Instruction,
    userName: string,
    amount = 0n
  ): ClusterBuildStep<ClusterBuildContext, WriteInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      `real liqsol_core ${instruction} (${userName})`,
      { timeoutMs: Constants.WriteTimeoutMs },
      { kind: "SolanaGenesisSteps.WriteInput", instruction, userName, amount },
      runWrite
    )
  }

  /** Submit one instruction, signed by its actual user/admin.
   * @param ctx - Cluster context.
   * @param input - Instruction and signer.
   * @param signal - Step lifetime.
   */
  export async function runWrite(
    ctx: ClusterBuildContext,
    input: WriteInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const user = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      input.userName
    )
    const pdas = addresses(ctx, user.publicKey)
    const program = SolanaLiqSyndicationTool.loadLiqsolProgram(ctx, user)
    const takesAmount = [
      Instruction.synd,
      Instruction.purchase,
      Instruction.desynd
    ].includes(input.instruction)
    Assert.ok(
      !takesAmount || input.amount > 0n,
      "a token instruction needs a positive amount"
    )
    const transaction = await program.methods[input.instruction](
      ...(takesAmount ? [new anchor.BN(input.amount.toString())] : [])
    )
      .accountsStrict(instructionAccounts(input.instruction, pdas))
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: Constants.ComputeUnitLimit
        })
      ])
      .transaction()
    const signature = await ctx.solana.connection.sendTransaction(
      transaction,
      [user],
      { skipPreflight: false }
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `SolanaGenesisSteps.${input.instruction}`
    )
  }

  /** Read an account with the deployed program's Anchor coder (independent of capital-index).
   * @param ctx - Cluster context.
   * @param address - Canonical account address.
   * @param accountName - Anchor coder name.
   * @param commitment - Requested finality.
   * @returns The decoded account, or undefined when absent.
   */
  export async function readAccount<T>(
    ctx: ClusterBuildContext,
    address: PublicKey,
    accountName: string,
    commitment: Commitment = "confirmed"
  ): Promise<T> {
    const account = await ctx.solana.connection.getAccountInfo(
      address,
      commitment
    )
    if (!account) return undefined
    return SolanaOutpostProgramTool.loadReadOnlyProgram(
      ctx.solana.connection,
      ctx.config.solanaPath
    ).coder.accounts.decode<T>(accountName, account.data)
  }

  /** Refuse missing/unbuilt exporter paths before spending on fixture transactions.
   * @returns The absolute capital-index checkout path.
   */
  export function capitalIndexPath(): string {
    const configured = process.env[Constants.CapitalIndexPathEnvironment]
    Assert.ok(
      configured,
      `set ${Constants.CapitalIndexPathEnvironment} to the built capital-index checkout`
    )
    const root = Path.resolve(configured)
    for (const relative of [
      "scripts/export-solana-genesis.js",
      "dist/opp/solana-opp-snapshot.service.js"
    ]) {
      Assert.ok(
        Fs.existsSync(Path.join(root, relative)),
        `build capital-index first: missing ${relative}`
      )
    }
    return root
  }

  /** One external exporter invocation, with either an output key or an expected PreLaunch refusal. */
  export interface ExportInput extends StepInput {
    kind: "SolanaGenesisSteps.ExportInput"
    fileName: string
    output?: OutputKey<SolanaGenesisSnapshot>
    expectRefusal: boolean
  }

  /** Plan one invocation of the actual capital-index CLI.
   * @param actor - Report actor.
   * @param name - Step name.
   * @param fileName - Artifact basename within this cluster.
   * @param output - Typed cross-step output, omitted for the expected refusal.
   * @returns The external-process Step.
   */
  export function planExport(
    actor: Report.Actor,
    name: string,
    fileName: string,
    output?: OutputKey<SolanaGenesisSnapshot>
  ): ClusterBuildStep<ClusterBuildContext, ExportInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      "invoke capital-index's real finalized genesis exporter",
      { timeoutMs: Constants.WriteTimeoutMs },
      {
        kind: "SolanaGenesisSteps.ExportInput",
        fileName,
        output,
        expectRefusal: output == null
      },
      runExport
    )
  }

  /** Spawn the external implementation with ONLY the local outpost endpoint/program selected.
   * @param ctx - Cluster context.
   * @param input - Artifact and expected outcome.
   * @param signal - Step/process lifetime.
   */
  export async function runExport(
    ctx: ClusterBuildContext,
    input: ExportInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const root = capitalIndexPath()
    const directory = Path.join(
      ctx.config.dataPath,
      Constants.ArtifactDirectory
    )
    Fs.mkdirSync(directory, { recursive: true })
    const output = Path.join(directory, input.fileName)
    Assert.ok(!Fs.existsSync(output), `refuse to overwrite snapshot ${output}`)
    const invoke = () =>
      execFileAsync(
        process.execPath,
        [
          Path.join(root, "scripts/export-solana-genesis.js"),
          "--output",
          output
        ],
        {
          cwd: root,
          signal,
          timeout: scaleTimeoutMs(Constants.WriteTimeoutMs),
          maxBuffer: Constants.ProcessMaxBuffer,
          env: {
            ...process.env,
            HELIUS_RPC_URL: ctx.solana.connection.rpcEndpoint,
            SOLANA_OPP_PROGRAM_ID: SolanaLiqSyndicationTool.deriveBasePdas(
              ctx.config.solanaPath
            ).liqsolCoreProgram.toBase58(),
            SOLANA_OPP_GLOBAL_STATE: SolanaLiqSyndicationTool.deriveBasePdas(
              ctx.config.solanaPath
            ).globalState.toBase58()
          }
        }
      )
    if (input.expectRefusal) {
      await Assert.rejects(
        invoke,
        /Genesis requires finalized Launching state, got PreLaunch/
      )
      Assert.ok(
        !Fs.existsSync(output),
        "a refused export must create no genesis artifact"
      )
      return
    }
    await invoke()
    const snapshot = SolanaGenesisSnapshotSchema.parse(
      JSON.parse(Fs.readFileSync(output, "utf8"))
    )
    ctx.outputs.set(input.output, snapshot)
  }

  /** Wait only for the Launching TRANSACTION's finality, never for an epoch boundary.
   * @param ctx - Cluster context.
   */
  export async function assertLaunchingFinalized(
    ctx: ClusterBuildContext
  ): Promise<void> {
    const pdas = SolanaLiqSyndicationTool.deriveBasePdas(ctx.config.solanaPath)
    await pollUntil(
      "Launching transition finalized",
      async () => {
        const state = await readAccount<GlobalLaunchState>(
          ctx,
          pdas.globalState,
          "globalState",
          "finalized"
        )
        return state && Object.keys(state.wireState)[0] === WireState.launching
      },
      Constants.WriteTimeoutMs,
      Constants.PollIntervalMs
    )
  }
}
