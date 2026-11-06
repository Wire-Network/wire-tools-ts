import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  LIQYield,
  SyndicateLIQ
} from "@wireio/opp-typescript-models"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { upperFirst } from "lodash"
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
import { pollFor, verifyStep } from "../orchestration/StepTools.js"
import { mapSeries } from "../utils/asyncUtils.js"
import { compareBigInt } from "../utils/bigintUtils.js"
import { FlowScenario } from "./FlowScenario.js"
import { readEnvelopeAttestations } from "./oppEnvelopeScan.js"

const { Actor } = Report
const { SysioContractName, SysioSyndItemKind } = SysioContracts

/** Common provisioning and reads for the live syndication scenarios. */
export abstract class SyndicationScenario extends FlowScenario {
  /**
   * Provision independent users and the bond provider that receives the mock import, then
   * launch the outpost.
   *
   * @param cluster - The build root.
   * @param users - The flow's syndicating participants.
   * @param provider - The account that receives the imported shadow and provides bonds;
   *   {@link SyndicationScenario.DefaultBondProvider} (`synd.bonder`) unless the flow names
   *   another, or `null` when no flow account provides bonds (the cluster's own batch
   *   operators underwrite from their imported credits).
   * @return The self-registered setup PhaseGroup.
   */
  protected planSetup(
    cluster: ClusterBuild,
    users: readonly SyndicationScenario.User[],
    provider: SyndicationScenario.BondProvider | null = SyndicationScenario.DefaultBondProvider
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
    if (provider != null) this.planBondProvider(group, provider)
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

  /** Deliver the mock import to `provider` by createlink: create, resource policy, link, verify. */
  private planBondProvider(
    group: ClusterBuildPhaseGroup,
    provider: SyndicationScenario.BondProvider
  ): void {
    const { account, role } = provider,
      options = SyndicationScenario.WriteOptions
    ClusterBuildPhase.create(
      group,
      `Provision${upperFirst(role)}`,
      `Deliver the imported shadow to its ${role}`
    ).push(
      Steps.account.planCreateKeyed(
        Actor.Underwriter,
        `create-${role}`,
        `create the ${role} account`,
        options,
        account,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.Underwriter,
        `${role}-resources`,
        `allocate ${role} resources`,
        options,
        SyndicationScenario.resourcePolicy(account)
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.Underwriter,
        `link-${role}`,
        "deliver the mock import by createlink",
        options,
        account,
        Steps.registry.MockSyndicationBonderLabel
      ),
      verifyStep(
        Actor.Underwriter,
        `verify-${role}`,
        "the imported position is liquid shadow",
        async ctx => {
          Steps.registry.readMockSyndicationBonder(ctx)
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, account),
            BigInt(Steps.registry.MockSyndicationImportAmount)
          )
        }
      )
    )
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
  export const Chain = Constants.SOLANA_CHAIN_CODENAME
  /** Registered shadow codename. */
  export const Token = Constants.LIQSOL_CODENAME
  /** Code stamped on Solana attestations. */
  export const TokenCode = BigInt(SlugName.from(Token))
  /** Bonder account shared by isolated scenario clusters. */
  export const Bonder = "synd.bonder"
  /**
   * The account {@link SyndicationScenario.planSetup} delivers the mock syndication import
   * to, and the role it is named by in the Report.
   */
  export interface BondProvider {
    /** The on-chain account that receives the import and provides bonds. */
    readonly account: string
    /**
     * Lowercase role word the setup Steps are named by (`create-<role>`,
     * `Provision<Role>`); changing it renames those Report rows.
     */
    readonly role: string
  }
  /** The flow-driven bonder every manual-bond scenario provisions. */
  export const DefaultBondProvider: BondProvider = {
    account: Bonder,
    role: "bonder"
  }
  /**
   * The fee `sysio.synd` takes: floor(amount * feeBps / 10000) plus flatFee.
   * Syndication has no flat charge; returns use the pair’s desynd_fee_flat.
   *
   * @param amount - Gross base units the fee is taken from (syndicated or desyndicated).
   * @param feeBps - The pair's `synd_fee_bps` or `desynd_fee_bps`.
   * @param flatFee - Flat base-unit charge, zero for syndication.
   * @return The fee in base units.
   */
  export import feeOf = WireSyndicationTool.feeOf
  /** Shortest supported depot epoch. */
  export const EpochDurationSec = 60
  /** Wallet funding including transaction headroom. */
  export const Funding = 20_000_000_000n
  /** Deposited principal available for each user's syndications. */
  export const Deposit = 10_000_000_000n
  /** Base-unit precision of shadow LIQSOL. */
  export const Precision = 9
  /** Contract basis-point denominator. */
  export import BasisPoints = WireSyndicationTool.BasisPoints
  /** Contract bond increment at nine decimal places. */
  export const Increment = 10_000_000n
  /**
   * The bond coverage `sysio.bond` requires for `amount`: rounded up to {@link Increment}.
   *
   * @param amount - Gross syndicated base units.
   * @return The covered amount.
   */
  export function coveredOf(amount: bigint): bigint {
    return ((amount + Increment - 1n) / Increment) * Increment
  }
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
    return SyndicationUserSteps.nodeOwnerPolicy(owner, {
      net: Constants.DEFAULT_RESOURCE_WEIGHT,
      cpu: Constants.DEFAULT_RESOURCE_WEIGHT,
      ram: Constants.DEFAULT_RAM_WEIGHT
    })
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
    return WireSyndicationTool.readLiqBalance(ctx, account, Token)
  }
  /** Current protocol fee pot, zero before the first fee. */
  export async function readFees(ctx: ClusterBuildContext): Promise<bigint> {
    const row = await WireSyndicationTool.readFeepot(ctx, Token)
    return row ? BigInt(row.balance) : 0n
  }
  /** Persisted ED public key in the depot's byte encoding. */
  export function publicKey(ctx: ClusterBuildContext, user: User): string {
    return SolanaFundingTool.publicKeyHex(ctx.config.dataPath, user.keypairName)
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
  /**
   * The decoded `SyndicateLIQ` attestations the Solana outpost relayed to the depot for `user`'s
   * wallet and `amount`, read from the cluster's OPP debugging artifacts.
   *
   * @param ctx - The build context whose cluster path holds the artifacts.
   * @param user - The syndicating user, identified by their persisted wallet.
   * @param amount - The syndicated amount, in base units.
   * @return Every matching attestation; empty until the debugging plugin has persisted the
   *   envelope that carries one.
   */
  export async function readDecodedSyndications(
    ctx: ClusterBuildContext,
    user: User,
    amount: bigint
  ): Promise<SyndicateLIQ[]> {
    const wallet = publicKey(ctx, user)
    return (
      await readEnvelopeAttestations(
        oppDebuggingPath(ctx.config.clusterPath),
        DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        AttestationType.SYNDICATE_LIQ
      )
    )
      .map(bytes => SyndicateLIQ.fromBinary(bytes))
      .filter(
        message =>
          message.amount?.amount === amount &&
          Buffer.from(message.user?.address).toString("hex") === wallet
      )
  }
  /** The two Solana → depot attestation types that carry the outpost's custody reading. */
  export const CustodyAttestationTypes = [
    AttestationType.SYNDICATE_LIQ,
    AttestationType.LIQ_YIELD
  ] as const

  /**
   * One custody-carrying attestation the Solana outpost relayed: a `SyndicateLIQ` or a
   * `LIQYield`. Both share the outpost's one liq-attestation `sequence` and carry
   * `total_syndicated`, the pool's live custody when the outpost built the message.
   */
  export interface CustodyAttestation {
    readonly type: (typeof CustodyAttestationTypes)[number]
    /** The outpost's shared, strictly increasing liq-attestation sequence. */
    readonly sequence: bigint
    /** Syndicated amount, or yield claimed into custody, in base units. */
    readonly amount: bigint
    /** The pool's custody balance after this message's effect. */
    readonly totalSyndicated: bigint
  }

  /**
   * Every custody-carrying attestation the Solana outpost relayed to the depot, read from the
   * cluster's OPP debugging artifacts, one per `sequence` (an envelope several operators
   * delivered persists more than once) in sequence order. The last one names the pool's
   * custody as of the newest message persisted so far.
   *
   * @param ctx - The build context whose cluster path holds the artifacts.
   * @return The attestations, ascending by sequence; empty before any is persisted.
   */
  export async function readCustodyAttestations(
    ctx: ClusterBuildContext
  ): Promise<CustodyAttestation[]> {
    const directory = oppDebuggingPath(ctx.config.clusterPath),
      decoded = (
        await mapSeries([...CustodyAttestationTypes], async type =>
          (
            await readEnvelopeAttestations(
              directory,
              DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
              type
            )
          ).map(bytes => decodeCustodyAttestation(type, bytes))
        )
      ).flat(),
      bySequence = new Map(
        decoded.map(attestation => [attestation.sequence, attestation])
      )
    return [...bySequence.values()].sort((left, right) =>
      compareBigInt(left.sequence, right.sequence)
    )
  }

  /**
   * The generated-model decoder of each custody attestation type. A `Record` keyed by the
   * type union, so adding a type without its decoder fails to compile — the exhaustiveness a
   * `match().exhaustive()` would give (ts-pattern does not narrow these protobuf enum members).
   */
  export const CustodyAttestationDecoders: Record<
    CustodyAttestation["type"],
    (bytes: Uint8Array) => SyndicateLIQ | LIQYield
  > = {
    [AttestationType.SYNDICATE_LIQ]: bytes => SyndicateLIQ.fromBinary(bytes),
    [AttestationType.LIQ_YIELD]: bytes => LIQYield.fromBinary(bytes)
  }

  /**
   * Decode one custody-carrying attestation payload of `type` with its generated model.
   *
   * @param type - SYNDICATE_LIQ or LIQ_YIELD.
   * @param bytes - The attestation payload.
   * @return The decoded custody reading.
   */
  export function decodeCustodyAttestation(
    type: CustodyAttestation["type"],
    bytes: Uint8Array
  ): CustodyAttestation {
    const message = CustodyAttestationDecoders[type](bytes)
    return {
      type,
      sequence: message.sequence,
      amount: message.amount?.amount ?? 0n,
      totalSyndicated: message.totalSyndicated
    }
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
    request: WireSyndicationTool.RequestKey
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const { envelope, matching } = await pollFor(
          name,
          async () => {
            const held = await WireSyndicationTool.readHeldEnvelope(
              ctx,
              Chain,
              Token,
              SysioSyndItemKind.SYNDICATION,
              amount,
              publicKey(ctx, user)
            )
            if (!held) return null
            // The debugging plugin persists the relayed envelope after the depot accepts it, so
            // the decoded attestation can trail the held row; wait for both.
            const decoded = await readDecodedSyndications(ctx, user, amount)
            return decoded.length === 0
              ? null
              : { envelope: held, matching: decoded }
          },
          ProtocolTiming.SingleHopBudgetMs,
          PollMs
        )
        ctx.outputs.set(epoch, envelope.epoch_index)
        ctx.outputs.set(request, envelope.request_id)
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
