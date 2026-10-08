import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  SyndicateLIQ
} from "@wireio/opp-typescript-models"
import { Asset, SlugName, SysioContracts } from "@wireio/sdk-core"
import { Constants, ProtocolTiming } from "../Constants.js"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ClusterBuildStep,
  outputKey,
  type OutputKey,
  type ClusterBuildStepOptions,
  type StepInput,
  Steps,
  SyndicationUserSteps
} from "../orchestration/index.js"
import { Report } from "../report/Report.js"
import {
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  WireState
} from "../tools/solana/index.js"
import { WireSyndicationTool } from "../tools/wire/index.js"
import { SolanaOutpostBootstrapper } from "../orchestration/solana/SolanaOutpostBootstrapper.js"
import { pollUntil } from "../orchestration/StepTools.js"
import { verifyStep } from "../orchestration/StepTools.js"
import { FlowScenario } from "./FlowScenario.js"
import { readEnvelopeAttestations } from "./oppEnvelopeScan.js"

const { Actor } = Report
const { SysioContractName, SysioSyndItemKind } = SysioContracts

/** Common provisioning and reads for the live syndication scenarios. */
export abstract class SyndicationScenario extends FlowScenario {
  /** Provision independent users and the imported bonder, then launch the outpost. */
  protected planSetup(
    cluster: ClusterBuild,
    users: readonly SyndicationScenario.User[]
  ): ClusterBuildPhaseGroup {
    const group = ClusterBuildPhaseGroup.create(
        cluster,
        "SyndicationSetup",
        "Provision linked accounts and launch the Solana outpost"
      ),
      options = SyndicationScenario.WriteOptions
    ClusterBuildPhase.create(
      group,
      "SnapshotConfiguration",
      "Save governance configuration for restoration"
    ).push(
      verifyStep(
        Actor.Sysio,
        "save-pair-config",
        "snapshot the original pair configuration",
        async ctx => {
          const config = await WireSyndicationTool.readSyndicationConfig(
            ctx,
            SyndicationScenario.Chain,
            SyndicationScenario.Token
          )
          Assert.ok(config, "missing bootstrap pair configuration")
          ctx.outputs.set(SyndicationScenario.OriginalConfigKey, config)
        }
      )
    )
    const bonder = ClusterBuildPhase.create(
      group,
      "ProvisionBonder",
      "Deliver the imported shadow to its bonder"
    )
    bonder.push(
      Steps.account.planCreateKeyed(
        Actor.Underwriter,
        "create-bonder",
        "create the bonder account",
        options,
        SyndicationScenario.Bonder,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.Underwriter,
        "bonder-resources",
        "allocate bonder resources",
        options,
        SyndicationScenario.resourcePolicy(SyndicationScenario.Bonder)
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.Underwriter,
        "link-bonder",
        "deliver the mock import by createlink",
        options,
        SyndicationScenario.Bonder,
        Steps.registry.MockSyndicationBonderLabel
      ),
      verifyStep(
        Actor.Underwriter,
        "verify-bonder",
        "the imported position is liquid shadow",
        async ctx => {
          Steps.registry.readMockSyndicationBonder(ctx)
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              SyndicationScenario.Bonder
            ),
            BigInt(Steps.registry.MockSyndicationImportAmount)
          )
        }
      )
    )
    users.forEach(user => {
      const phase = ClusterBuildPhase.create(
        group,
        `Provision-${user.account}`,
        "Create and fund the flow participant"
      )
      phase.push(
        Steps.account.planCreateKeyed(
          Actor.User,
          `create-${user.account}`,
          "create the participant account",
          options,
          user.account,
          Constants.DEV_K1_PUBLIC_KEY
        ),
        SyndicationUserSteps.planResourcePolicy(
          Actor.User,
          `resources-${user.account}`,
          "allocate participant resources",
          options,
          SyndicationScenario.resourcePolicy(user.account)
        ),
        SolanaFundingTool.planKeypairAirdrop(
          Actor.User,
          `fund-${user.account}`,
          "fund the Solana wallet",
          SyndicationScenario.OutpostOptions,
          user.keypairName,
          SyndicationScenario.Funding
        ),
        SolanaLiqSyndicationTool.planDepositForLiqsol(
          Actor.User,
          `deposit-${user.account}`,
          "deposit SOL for liqSOL",
          SyndicationScenario.OutpostOptions,
          user.keypairName,
          SyndicationScenario.Deposit
        )
      )
      if (user.linked)
        phase.push(
          SyndicationUserSteps.planLinkSolanaKey(
            Actor.User,
            `link-${user.account}`,
            "link the syndicating wallet",
            options,
            user.account,
            user.keypairName
          )
        )
    })
    ClusterBuildPhase.create(
      group,
      "LaunchOutpost",
      "Map LIQSOL and transition to PostLaunch"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "prelaunch",
        "the fresh outpost is PreLaunch",
        async ctx => {
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readWireState(ctx),
            WireState.preLaunch
          )
        }
      ),
      SolanaLiqSyndicationTool.planSetLiqTokenAddress(
        Actor.SolanaOutpost,
        "map-liqsol",
        "map the LIQSOL code",
        SyndicationScenario.OutpostOptions,
        SyndicationScenario.TokenCode
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "launching",
        "enter Launching",
        SyndicationScenario.OutpostOptions,
        WireState.launching
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "post-launch",
        "enter PostLaunch",
        SyndicationScenario.OutpostOptions,
        WireState.postLaunch
      )
    )
    return group
  }

  /** Restore the saved pair rules and verify the final safety invariant. */
  protected planFinish(cluster: ClusterBuild): ClusterBuildPhase {
    return ClusterBuildPhase.create(
      cluster,
      "RestoreAndVerify",
      "Restore pair configuration and verify solvency"
    ).push(
      SyndicationScenario.planRestoreConfig(
        Actor.Sysio,
        "restore-config",
        "restore the original governance rules",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "config-restored",
        "the pair configuration matches its original row",
        async ctx => {
          Assert.deepStrictEqual(
            await WireSyndicationTool.readSyndicationConfig(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token
            ),
            ctx.outputs.assert(SyndicationScenario.OriginalConfigKey)
          )
        }
      ),
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "cord-clear-no-mismatch",
        "cord clear and no custody mismatches",
        {}
      )
    )
  }
}

/** Shared identities, protocol budgets and typed state readers. */
export namespace SyndicationScenario {
  /** A participant whose persisted Solana key identifies its syndication. */
  export interface User {
    readonly account: string
    readonly keypairName: string
    readonly linked: boolean
  }
  /** Registered outpost codename. */
  export const Chain = SolanaOutpostBootstrapper.SolanaChainCodename
  /** Registered shadow codename. */
  export const Token = "LIQSOL"
  /** Code stamped on Solana attestations. */
  export const TokenCode = BigInt(SlugName.from(Token))
  /** Bonder account shared by isolated scenario clusters. */
  export const Bonder = "synd.bonder"
  /** Shortest supported depot epoch. */
  export const EpochDurationSec = 60
  /** Wallet funding including transaction headroom. */
  export const Funding = 20_000_000_000n
  /** Deposited principal available for each user's syndications. */
  export const Deposit = 10_000_000_000n
  /** Base-unit precision of shadow LIQSOL. */
  export const Precision = 9
  /** Contract basis-point denominator. */
  export const BasisPoints = 10_000n
  /** Contract bond increment at nine decimal places. */
  export const Increment = 10_000_000n
  /** Queue work sufficient for all scenario items. */
  export const CrankLimit = 100
  /** Bounded table page size; truncated reads are refused. */
  export const QueryLimit = 1_000
  /** Poll interval for state and artifact reads. */
  export const PollMs = 1_000
  /** Irreversible depot write budget. */
  export const WriteOptions = {
    timeoutMs: ProtocolTiming.IrreversibilityBaseMs
  }
  /** Solana transaction budget. */
  export const OutpostOptions = {
    timeoutMs: ProtocolTiming.OutpostWriteBudgetMs
  }
  /** Single-hop propagation plus the poll deadline margin. */
  export const VerifyOptions = {
    timeoutMs:
      ProtocolTiming.SingleHopBudgetMs + ProtocolTiming.PollDeadlineBufferMs
  }
  /** Configuration captured before scenario governance changes. */
  export const OriginalConfigKey =
    outputKey<SysioContracts.SysioSyndSyndConfigType>(
      "SyndicationScenario.originalConfig",
      "original pair rules"
    )

  /** Generate the separate resource-policy action for an account. */
  export function resourcePolicy(
    owner: string
  ): SysioContracts.SysioRoaAddpolicyAction {
    const weight = "25.0000 SYS"
    return {
      owner,
      issuer: Constants.BOOTSTRAP_NODE_OWNER,
      net_weight: weight,
      cpu_weight: weight,
      ram_weight: weight,
      time_block: 0,
      network_gen: 0
    }
  }
  /** Parse an asset without converting its integer amount through floating point. */
  export function units(quantity: string): bigint {
    return BigInt(Asset.from(quantity).units.toString())
  }
  /** Encode a positive LIQSOL quantity in the registered depot frame. */
  export function quantity(amount: bigint): string {
    Assert.ok(amount >= 0n, "negative shadow quantity")
    const scale = 10n ** BigInt(Precision)
    return `${amount / scale}.${String(amount % scale).padStart(Precision, "0")} ${Token}`
  }
  /** Current consensus epoch from the generated accessor. */
  export async function readEpoch(ctx: ClusterBuildContext): Promise<number> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.epochstate.query({ limit: 1 })
    Assert.ok(rows.length === 1, "missing epoch state")
    return rows[0].current_epoch_index
  }
  /** Liquid shadow held by one account, zero before its first credit. */
  export async function readBalance(
    ctx: ClusterBuildContext,
    account: string
  ): Promise<bigint> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .tables.accounts.query({ scope: account, limit: QueryLimit })
    Assert.ok(!more, "truncated holder read")
    const row = rows.find(
      value => Asset.from(value.balance).symbol.name === Token
    )
    return row ? units(row.balance) : 0n
  }
  /** Current protocol fee pot, zero before the first fee. */
  export async function readFees(ctx: ClusterBuildContext): Promise<bigint> {
    const row = await WireSyndicationTool.readFeepot(ctx, Token)
    return row ? BigInt(row.balance) : 0n
  }
  /** Persisted ED public key in the depot's byte encoding. */
  export function publicKey(ctx: ClusterBuildContext, user: User): string {
    return SolanaFundingTool.loadKeypair(ctx.config.dataPath, user.keypairName)
      .publicKey.toBuffer()
      .toString("hex")
  }
  /** Read a previously identified envelope, refusing missing state. */
  export async function readEnvelope(
    ctx: ClusterBuildContext,
    epoch: OutputKey<number>
  ): Promise<SysioContracts.SysioSyndEnvelopeRowType> {
    const row = await WireSyndicationTool.readEnvelope(
      ctx,
      Chain,
      Token,
      ctx.outputs.assert(epoch)
    )
    Assert.ok(row, "missing scenario envelope")
    return row
  }
  /** Wait for intake, prove it is held and capture the consensus epoch and request. */
  export function planVerifyIntake(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    user: User,
    amount: bigint,
    epoch: OutputKey<number>,
    request: OutputKey<SysioContracts.SysioBondApproveAction["request_id"]>
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await pollUntil(
          name,
          async () => {
            const envelope = await WireSyndicationTool.readHeldEnvelope(
              ctx,
              Chain,
              Token,
              SysioSyndItemKind.SYNDICATION,
              amount,
              publicKey(ctx, user)
            )
            if (!envelope) return false
            ctx.outputs.set(epoch, envelope.epoch_index)
            ctx.outputs.set(request, envelope.request_id)
            return true
          },
          ProtocolTiming.SingleHopBudgetMs,
          PollMs
        )
        const messages = (
            await readEnvelopeAttestations(
              oppDebuggingPath(ctx.config.clusterPath),
              DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
              AttestationType.SYNDICATE_LIQ
            )
          ).map(bytes => SyndicateLIQ.fromBinary(bytes)),
          matching = messages.filter(
            message =>
              message.amount?.amount === amount &&
              Buffer.from(message.user?.address).toString("hex") ===
                publicKey(ctx, user)
          )
        Assert.ok(matching.length > 0, "missing decoded syndication")
        Assert.ok(
          matching.every(message => message.totalSyndicated >= amount),
          "custody attestation is below its own syndication"
        )
      },
      options
    )
  }
  /** Plan one explicit queue crank. */
  export function planCrank(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return Steps.contracts.sysio.synd.planCrank(
      actor,
      name,
      description,
      options,
      { limit: CrankLimit },
      Bonder
    )
  }
  /** Input names the saved row, keeping restoration in the Report. */
  export interface RestoreConfigInput extends StepInput {
    readonly kind: "SyndicationScenario.RestoreConfigInput"
    readonly config: OutputKey<SysioContracts.SysioSyndSyndConfigType>
  }
  /** Plan the single governance write that restores bootstrap rules. */
  export function planRestoreConfig(
    actor: Report.Actor,
    name: string,
    description: string,
    options: typeof WriteOptions
  ): ClusterBuildStep<ClusterBuildContext, RestoreConfigInput> {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      {
        kind: "SyndicationScenario.RestoreConfigInput",
        config: OriginalConfigKey
      },
      runRestoreConfig
    )
  }
  /** Resolve the saved row and invoke exactly one existing setconfig runner. */
  export async function runRestoreConfig(
    ctx: ClusterBuildContext,
    input: RestoreConfigInput,
    signal: AbortSignal
  ): Promise<void> {
    await Steps.contracts.sysio.synd.runSetconfig(
      ctx,
      {
        kind: "SyndContractSteps.SetconfigInput",
        data: ctx.outputs.assert(input.config)
      },
      signal
    )
  }
}
