import Assert from "node:assert"

import type { PublicKey } from "@solana/web3.js"
import {
  AttestationType,
  BatchOperatorGroups,
  Envelope,
  OperatorType
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import {
  mapOutpostChains,
  OutpostChainCodename,
  OutpostChainCodenames,
  type ClusterConfig,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"
import {
  ClusterBuildStep,
  OperatorDaemonArtifactsKey,
  ProtocolTiming,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool,
  Steps,
  WireCollateralTool,
  getLogger,
  isPackedCode,
  loadOutpostContract,
  matchesProtoEnum,
  packedSlugValue,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type OperatorAccount,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"

import { TerminationScenarioConstants as Constants } from "../TerminationScenarioConstants.js"

const {
  SysioOpregActiontype,
  SysioOpregChainServiceStatus,
  SysioOpregOperatorstatus
} = SysioContracts

const log = getLogger(__filename)

/** The Ethereum outpost contract whose inbound cursor {@link TerminationSteps.readInboundCursors} reads. */
const EthereumInboundContract = "OPPInbound"

/** The deployment-record path of {@link EthereumInboundContract} under the outpost addresses. */
const EthereumInboundAddressPath = ["outpost"]

/** Anchor account-client surface for the runtime-loaded outpost IDL. */
interface SolanaAccountClient {
  fetch(address: PublicKey): Promise<unknown>
}

/** The Ethereum inbound cursor advances only after an envelope is accepted. */
interface EthereumInboundView {
  nextEpochIndex(): Promise<bigint>
}

/** The Solana outpost configuration's accepted inbound epoch cursor. */
interface SolanaOutpostConfigAccount {
  nextEpochIndex: number
}

/**
 * The batch-operator-termination scenario's reads, checks and its one flow-local write: the
 * doomed operator's registry rows, the checks every verify Step of the scenario asserts (exported
 * so the unit tests drive them against fixture rows), the post-eviction rotation targets of each
 * outpost chain, and governance's `terminate` of the operator by its durable label.
 */
export namespace TerminationSteps {
  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * The doomed operator's WIRE account, resolved from the key store by its label.
   *
   * @param ctx - The build context.
   * @returns The operator's account.
   * @throws When the operator is not in the key store.
   */
  export function doomedOperatorAccount(ctx: ClusterBuildContext): string {
    return ctx.keyStore.assertOperator(Constants.DoomedOperatorLabel).account
  }

  /**
   * Poll until the missed chain's schedule window holds a seat of the doomed operator exactly when `seated`: a
   * tail group draws the seat in, and it leaves once that group slides out. Each needs the chain to advance,
   * so the poll keeps the missed chain due with keep-due traffic (`EpochAdvanceSteps.pollUntilKeepingDue`).
   * A failed `epochstate` read mid-advance is logged and polled again.
   *
   * @param ctx - The build context.
   * @param seated - Whether to wait for a seat (`true`) or for none (`false`).
   * @param timeoutMs - The poll deadline (ms).
   * @param signal - Abort signal.
   * @param intervalMs - The delay between reads (ms).
   * @throws When the operator is not in the key store, or the deadline passes first.
   */
  export async function awaitMissedChainSeat(
    ctx: ClusterBuildContext,
    seated: boolean,
    timeoutMs: number,
    signal: AbortSignal,
    intervalMs: number = Constants.PollIntervalMs
  ): Promise<void> {
    const account = doomedOperatorAccount(ctx)
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      [Constants.MissedChain],
      `${Constants.DoomedOperatorLabel} is seated (${seated}) in the ${Constants.MissedChain} epochstate.batch_op_groups`,
      async () => {
        try {
          return (
            Steps.contracts.sysio.epoch.isSeated(
              await Steps.contracts.sysio.epoch.readEpochState(ctx, Constants.MissedChain),
              account
            ) === seated
          )
        } catch (error) {
          // Transient RPC failure mid-advance — log it and keep polling.
          log.warn(`epochstate read failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      },
      timeoutMs,
      intervalMs,
      signal
    )
  }

  /**
   * READ the doomed operator's `sysio.opreg::servchains` row on `chain`.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The membership row (absent when the operator never joined the chain).
   * @throws When the operator is not in the key store, or the read is truncated.
   */
  export async function readDoomedMembership(
    ctx: ClusterBuildContext,
    chain: OutpostChainCodename
  ): Promise<SysioContracts.SysioOpregServedChainType> {
    return Steps.contracts.sysio.opreg.readMembership(ctx, doomedOperatorAccount(ctx), chain)
  }

  /**
   * READ the doomed operator's `sysio.opreg::operators` row.
   *
   * @param ctx - The build context.
   * @returns The operator row.
   * @throws When the operator is not in the key store, or has no row.
   */
  export async function readDoomedOperator(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const operator = await WireCollateralTool.readOperatorRow(ctx, Constants.DoomedOperatorLabel)
    Assert.ok(operator != null, `${Constants.DoomedOperatorLabel} missing from sysio.opreg::operators`)
    return operator
  }

  /**
   * The packed chain codes of an operator's success-true `WITHDRAW_REMIT` audit entries — pure.
   * Termination credits each remitted balance to the operator's claim row and appends a
   * PERMANENT entry to its `recent_actions` ring buffer, so the ring buffer is the audit trail.
   *
   * @param operator - The operator row (absent when the operator has none).
   * @returns The chain codes, as packed numbers.
   */
  export function withdrawRemitChainCodes(
    operator: SysioContracts.SysioOpregOperatorEntryType
  ): Set<number> {
    const remits = (operator?.recent_actions ?? []).filter(
      entry =>
        matchesProtoEnum(
          entry.action?.action_type,
          SysioOpregActiontype,
          SysioOpregActiontype.ACTION_TYPE_WITHDRAW_REMIT
        ) &&
        // ABI-deserialised `success` arrives as numeric 1/0 (bool-as-uint8), not a JS boolean.
        Boolean(entry.success)
    )
    return new Set(remits.map(entry => packedSlugValue(entry.action.chain_code)))
  }

  /**
   * READ each outpost's accepted inbound epoch cursor: the Ethereum `OPPInbound.nextEpochIndex`
   * and the Solana `outpostConfig.nextEpochIndex`. Each advances only once its outpost accepted
   * an envelope of its own chain.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's next inbound epoch index.
   */
  export async function readInboundCursors(
    ctx: ClusterBuildContext
  ): Promise<PerOutpostChain<number>> {
    const addresses = ctx.outputs.assert(OperatorDaemonArtifactsKey).ethereumAddresses,
      ethereum = loadOutpostContract<EthereumInboundView>(
        ctx.config.ethereumPath,
        addresses,
        EthereumInboundContract,
        EthereumInboundAddressPath,
        ctx.ethereum.provider
      ),
      program = SolanaOutpostProgramTool.loadReadOnlyProgram(ctx.solana.connection, ctx.config.solanaPath),
      configAddress = SolanaOutpostProgramTool.derivePda(
        program.programId,
        Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OutpostConfig)
      ),
      accounts: Record<string, SolanaAccountClient> = program.account,
      [ethereumNext, solanaConfig] = await Promise.all([
        ethereum.nextEpochIndex(),
        accounts.outpostConfig.fetch(configAddress)
      ])
    return {
      [OutpostChainCodename.ETHEREUM]: Number(ethereumNext),
      [OutpostChainCodename.SOLANA]: Number((solanaConfig as SolanaOutpostConfigAccount).nextEpochIndex)
    }
  }

  // ── Checks (pure over the rows the verify Steps read) ─────────────────────

  /**
   * Assert the freshly registered operator row: present, not bootstrapped (a bootstrapped
   * operator bypasses the miss rails) and `OPERATOR_STATUS_UNKNOWN` (no collateral yet).
   *
   * @param operator - The operator row (absent when it never registered).
   * @throws When the row is absent, bootstrapped or not UNKNOWN.
   */
  export function assertRegisteredUnbootstrapped(
    operator: SysioContracts.SysioOpregOperatorEntryType
  ): void {
    Assert.ok(operator != null, `${Constants.DoomedOperatorLabel} missing from sysio.opreg::operators`)
    Assert.ok(
      !operator.is_bootstrapped,
      `${Constants.DoomedOperatorLabel} registered bootstrapped — it would bypass termination`
    )
    Assert.ok(
      matchesProtoEnum(operator.status, SysioOpregOperatorstatus, SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN),
      `${Constants.DoomedOperatorLabel} status not UNKNOWN (got ${operator.status})`
    )
  }

  /**
   * Assert the operator SERVES the missed chain and holds no membership of the unserved one.
   *
   * @param missed - Its membership of {@link TerminationScenarioConstants.MissedChain}.
   * @param unserved - Its membership of {@link TerminationScenarioConstants.UnservedChain}.
   * @throws When it does not serve the missed chain, or has an unserved-chain membership.
   */
  export function assertServesMissedChainOnly(
    missed: SysioContracts.SysioOpregServedChainType,
    unserved: SysioContracts.SysioOpregServedChainType
  ): void {
    Assert.ok(
      missed != null &&
        matchesProtoEnum(missed.status, SysioOpregChainServiceStatus, SysioOpregChainServiceStatus.SERVING),
      `${Constants.DoomedOperatorLabel} does not SERVE ${Constants.MissedChain} (got ${missed?.status})`
    )
    assertNoUnservedMembership(unserved)
  }

  /**
   * Whether a membership is `EVICTED` — pure.
   *
   * @param membership - The membership row (absent when the operator never joined).
   * @returns True when the row exists and is EVICTED.
   */
  export function isEvicted(membership: SysioContracts.SysioOpregServedChainType): boolean {
    return (
      membership != null &&
      matchesProtoEnum(membership.status, SysioOpregChainServiceStatus, SysioOpregChainServiceStatus.EVICTED)
    )
  }

  /**
   * Assert the eviction as recorded: the missed chain's membership is EVICTED, carries its rail's
   * `status_reason`, is stamped no earlier than the join, and no unserved-chain membership appeared.
   *
   * @param missed - The membership of the missed chain.
   * @param unserved - The membership of the unserved chain.
   * @throws When any of those does not hold.
   */
  export function assertEvictionRecorded(
    missed: SysioContracts.SysioOpregServedChainType,
    unserved: SysioContracts.SysioOpregServedChainType
  ): void {
    Assert.ok(
      isEvicted(missed),
      `${Constants.DoomedOperatorLabel}'s ${Constants.MissedChain} membership is not EVICTED (got ${missed?.status})`
    )
    Assert.ok(
      missed.status_reason.length > 0,
      `the eviction's status_reason is not populated (got ${JSON.stringify(missed.status_reason)})`
    )
    Assert.ok(
      Number(missed.updated_at_ms) >= Number(missed.joined_at_ms),
      `the eviction is stamped before the join (updated_at_ms ${missed.updated_at_ms}, joined_at_ms ${missed.joined_at_ms})`
    )
    assertNoUnservedMembership(unserved)
  }

  /** Assert the operator holds no membership of the chain it never joined. */
  function assertNoUnservedMembership(unserved: SysioContracts.SysioOpregServedChainType): void {
    Assert.ok(
      unserved == null,
      `${Constants.DoomedOperatorLabel} has a ${Constants.UnservedChain} membership it never joined`
    )
  }

  /**
   * Assert an eviction from one chain left the operator itself alone: still ACTIVE, not
   * terminated, and nothing remitted.
   *
   * @param operator - The operator row.
   * @param remitChainCodes - Its `WITHDRAW_REMIT` chain codes ({@link withdrawRemitChainCodes}).
   * @throws When the operator is not ACTIVE, is terminated, or had collateral remitted.
   */
  export function assertEvictedOperatorStaysActive(
    operator: SysioContracts.SysioOpregOperatorEntryType,
    remitChainCodes: ReadonlySet<number>
  ): void {
    Assert.ok(
      matchesProtoEnum(operator.status, SysioOpregOperatorstatus, SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE),
      `${Constants.DoomedOperatorLabel} status is ${operator.status}, not OPERATOR_STATUS_ACTIVE`
    )
    Assert.strictEqual(
      Number(operator.terminated_at),
      0,
      `an eviction must not terminate the operator (terminated_at ${operator.terminated_at})`
    )
    Assert.strictEqual(
      remitChainCodes.size,
      0,
      `an eviction must not remit ${Constants.DoomedOperatorLabel}'s collateral`
    )
  }

  /**
   * Assert governance's termination as recorded on the operator row: TERMINATED, a stamped
   * `terminated_at`, and the governance reason.
   *
   * @param operator - The operator row.
   * @throws When any of those does not hold.
   */
  export function assertTerminationRecorded(operator: SysioContracts.SysioOpregOperatorEntryType): void {
    Assert.ok(
      matchesProtoEnum(operator.status, SysioOpregOperatorstatus, SysioOpregOperatorstatus.OPERATOR_STATUS_TERMINATED),
      `${Constants.DoomedOperatorLabel} status is ${operator.status}, not OPERATOR_STATUS_TERMINATED`
    )
    Assert.ok(Number(operator.terminated_at) > 0, `terminated_at not populated (got ${operator.terminated_at})`)
    Assert.strictEqual(
      operator.status_reason,
      Constants.GovernanceTerminationReason,
      "the operator row does not carry the governance termination reason"
    )
  }

  // ── Post-eviction rotation ─────────────────────────────────────────────────

  /** One outpost chain's post-eviction rotation target. */
  export interface RotationTarget {
    /** The groups of the chain's schedule window (`epochstate.batch_op_groups`). */
    readonly groupCount: number
    /** The inbound cursor the chain's outpost must pass: a full window past where it started. */
    readonly targetEpoch: number
  }

  /**
   * Each outpost chain's rotation target from its own `epochstate` row — pure. Each chain counts
   * its own epochs and runs its own window, so each outpost is held to a full window of ITS chain
   * past the later of the chain's index and the outpost's cursor.
   *
   * @param states - Each chain's `epochstate` row (`EpochContractSteps.readEpochStates`).
   * @param cursors - Each outpost's inbound cursor at the start ({@link readInboundCursors}).
   * @returns Each chain's target.
   * @throws When a chain has no row, or its window holds a single group.
   */
  export function rotationTargets(
    states: Readonly<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>>,
    cursors: Readonly<PerOutpostChain<number>>
  ): PerOutpostChain<RotationTarget> {
    return mapOutpostChains(chain => {
      const state = states[chain]
      Assert.ok(state != null, `sysio.epoch::epochstate has no ${chain} row`)
      const groupCount = state.batch_op_groups.length
      Assert.ok(
        groupCount > 1,
        `the ${chain} window has ${groupCount} group(s); the eviction regression requires multiple duty groups`
      )
      return {
        groupCount,
        targetEpoch: Math.max(Number(state.current_epoch_index), cursors[chain]) + groupCount
      }
    })
  }

  /**
   * The deadline of the post-eviction rotation (ms): on each chain, a full rotation of its window
   * plus the epoch that accepts its final envelope; the slowest chain's bounds the wait.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @param groupCounts - Each chain's window group count.
   * @returns The deadline (ms).
   */
  export function rotationDeadlineMs(
    config: ClusterConfig,
    groupCounts: Readonly<PerOutpostChain<number>>
  ): number {
    return Math.max(
      ...OutpostChainCodenames.map(chain =>
        ProtocolTiming.effectiveEpochsMs(
          config.outpostEpochDurationSec[chain],
          groupCounts[chain] + Constants.RotationFinalEnvelopeEpochs
        )
      )
    )
  }

  /**
   * The standing batch operators: every provisioned batch operator but the evicted one — pure.
   *
   * @param operators - Every operator account the key store provisioned.
   * @param evictedAccount - The evicted operator's account.
   * @returns The standing operators' accounts.
   */
  export function standingOperators(
    operators: readonly OperatorAccount[],
    evictedAccount: string
  ): Set<string> {
    return new Set(
      operators
        .filter(entry => entry.type === OperatorType.BATCH && entry.account !== evictedAccount)
        .map(entry => entry.account)
    )
  }

  /**
   * Every `BATCH_OPERATOR_GROUPS` window the depot's newest outbound envelope of `chain` publishes,
   * each as its groups' member accounts — pure over the `sysio.msgch::outenvelopes` rows.
   *
   * @param rows - Every outbound envelope row.
   * @param chain - The outpost chain.
   * @returns The published windows.
   * @throws When the chain has no outbound envelope, or it publishes no window.
   */
  export function publishedWindows(
    rows: readonly SysioContracts.SysioMsgchOutboundEnvelopeType[],
    chain: OutpostChainCodename
  ): string[][][] {
    const row = rows.find(entry => isPackedCode(entry.chain_code, chain))
    Assert.ok(row != null, `missing outbound envelope for chain ${chain}`)
    const windows = Envelope.fromBinary(Buffer.from(row.raw_envelope, "hex")).messages.flatMap(message =>
      (message.payload?.attestations ?? [])
        .filter(entry => entry.type === AttestationType.BATCH_OPERATOR_GROUPS)
        .map(entry =>
          BatchOperatorGroups.fromBinary(entry.data).groups.map(group =>
            group.operators.map(member => Buffer.from(member.address).toString("utf8"))
          )
        )
    )
    Assert.ok(windows.length > 0, `no published ${chain} group window at epoch ${row.epoch_index}`)
    return windows
  }

  /**
   * Assert one published window of `chain` after the eviction: it keeps the chain's own group
   * count, standing operators fill every seat, no operator repeats, and the evicted operator is
   * in no group.
   *
   * @param chain - The outpost chain (for the messages).
   * @param groups - The window's groups, as member accounts.
   * @param groupCount - The chain's own window group count ({@link RotationTarget.groupCount}).
   * @param groupSize - The seats per group.
   * @param evictedAccount - The evicted operator's account.
   * @param standing - The standing operators ({@link standingOperators}).
   * @throws On the first property that does not hold.
   */
  export function assertPublishedGroups(
    chain: OutpostChainCodename,
    groups: readonly (readonly string[])[],
    groupCount: number,
    groupSize: number,
    evictedAccount: string,
    standing: ReadonlySet<string>
  ): void {
    const members = groups.flat()
    Assert.strictEqual(groups.length, groupCount, `the published ${chain} window lost a group`)
    Assert.ok(
      groups.every(group => group.length === groupSize),
      `standing operators did not fill every ${chain} seat`
    )
    Assert.ok(!members.includes(evictedAccount), `the evicted operator re-entered a published ${chain} group`)
    Assert.strictEqual(new Set(members).size, groupCount * groupSize, `the published ${chain} groups repeat an operator`)
    Assert.ok(
      members.every(account => standing.has(account)),
      `a ${chain} replacement is not a standing operator`
    )
  }

  // ── Step: governance terminates the operator by its label (write) ─────────

  /** Input for {@link planTermination}. */
  export interface TerminationInput extends StepInput {
    readonly kind: "TerminationSteps.TerminationInput"
    /** The operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its account). */
    readonly label: string
    /** The `status_reason` the operator is terminated with. */
    readonly reason: string
  }

  /**
   * Governance terminates the operator globally (`sysio.opreg::terminate`). The operator's
   * `account` is resolved from `ctx.keyStore` at RUN time, like every other read of it.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param reason - The termination's `status_reason`.
   * @returns The `terminate` step.
   */
  export function planTermination<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    reason: string
  ): ClusterBuildStep<C, TerminationInput> {
    return ClusterBuildStep.create<C, TerminationInput>(
      actor,
      name,
      description,
      options,
      { kind: "TerminationSteps.TerminationInput", label, reason },
      runTermination
    )
  }

  /**
   * Named runner — resolve the account, then delegate ONE `terminate` to
   * `OpregContractSteps.runTerminate`.
   *
   * @param ctx - The build context.
   * @param input - The operator's label and the reason.
   * @param signal - Abort signal.
   * @throws When the operator is not in the key store, or the action fails.
   */
  export async function runTermination<C extends ClusterBuildContext>(
    ctx: C,
    input: TerminationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await Steps.contracts.sysio.opreg.runTerminate(
      ctx,
      {
        kind: "OpregContractSteps.TerminateInput",
        data: {
          account: ctx.keyStore.assertOperator(input.label).account,
          reason: input.reason
        }
      },
      signal
    )
  }
}
