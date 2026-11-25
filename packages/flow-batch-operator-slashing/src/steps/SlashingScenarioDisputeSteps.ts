import Assert from "node:assert"
import { ethers } from "ethers"
import { NodeOwnerTier } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  ClusterBuildContext,
  ClusterBuildStep,
  Constants as TestClusterConstants,
  ethereumKeyPairFromWallet,
  isNotEmpty,
  isPackedCode,
  matchesProtoEnum,
  outputKey,
  pollUntil,
  pushNodeOwnerReg,
  Report,
  Steps,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { bytesToHex, encodeTaggedEnvelope } from "../EnvelopeCanonicalCodec.js"
import {
  InboundTipReader,
  type OutpostConsensusRow,
  type OutpostInboundTips
} from "../InboundTipReader.js"
import { SlashingScenarioConstants as Constants } from "../SlashingScenarioConstants.js"

const { SysioContractName, SysioChalgDisputestatus, SysioOpregOperatorstatus } =
  SysioContracts

const log = getLogger(__filename)

/** The permission every flow-pushed action signs with. */
const ActivePermission = "active"
/** ISO-8601 Zulu suffix — chain timestamps are UTC; append when missing. */
const UtcZuluSuffix = "Z"

/**
 * Flow-local step factories + dispute-domain reads for the slashing scenario.
 * The `sysio.chalg` actions (`votedispute`, `chkdispute`), `sysio.msgch::deliver`,
 * `sysio.opreg::processbatch`, and `sysio.roa::nodeownreg` have no
 * shared `Steps.*` palette factories yet, so this namespace supplies them in the
 * same shape (`(actor, name, description, options, ...args) → ClusterBuildStep`,
 * ABI-exact action names, typed `StepInput`s, named runners). Cross-step values
 * (the contested epoch, the open dispute's id + canonical checksum) ride
 * `ctx.outputs` via the typed keys below.
 */
export namespace SlashingScenarioDisputeSteps {
  // ── Cross-step output keys ────────────────────────────────────────────────

  /** The frozen, dispute-operators-owned epoch hosting the divergent split. */
  export const ContestedEpochKey = outputKey<number>(
    "SlashingScenario.contestedEpoch",
    "the frozen dispute-operators-owned epoch hosting the divergent split"
  )

  /** What the Tier-1 electorate votes for — the open dispute + its canonical candidate. */
  export interface DisputeResolutionTarget {
    /** `sysio.chalg::disputes` row id of the OPEN dispute. */
    disputeId: number
    /** The candidate checksum delivered by the canonical operator. */
    canonicalChecksum: string
  }

  /** The open dispute's id + the canonical candidate checksum. */
  export const DisputeResolutionKey = outputKey<DisputeResolutionTarget>(
    "SlashingScenario.disputeResolution",
    "the open dispute's id + the canonical candidate checksum the Tier-1 electorate votes for"
  )

  // ── Envelope encoding + inbound chain tips ────────────────────────────────
  //
  // The canonical OPP codec (semantic-header derivation + tagged-envelope encoding) lives in
  // ../EnvelopeCanonicalCodec.ts and the single-flight tip reader in ../InboundTipReader.ts so
  // both can be unit-tested without this step module's cluster-tool dependency; see those files
  // for why the checksums are computed over a field-complete canonical encoding rather than
  // protobuf-ts `toBinary`, and for why the tip read must be single-flight.

  /** The tip reads shared across each contested epoch's parallel deliveries. */
  const inboundTipReader = new InboundTipReader()

  /**
   * The outpost's current inbound message + envelope tips from `sysio.msgch::outpcons`, read once
   * per `(chainCode, epochIndex)` and shared across that epoch's parallel deliveries (see
   * {@link InboundTipReader}). By the time this scenario runs, bootstrap emissions have advanced
   * both outposts' tips, so the synthetic dispute envelopes must continue from the real tips.
   *
   * @param ctx - The build context.
   * @param chainCode - The outpost slug_name.
   * @param epochIndex - The contested epoch (cache scope, so a later epoch re-reads).
   * @returns The outpost's inbound tips (each empty at genesis).
   */
  export function readInboundTips(
    ctx: ClusterBuildContext,
    chainCode: number,
    epochIndex: number
  ): Promise<OutpostInboundTips> {
    return inboundTipReader.read(chainCode, epochIndex, () =>
      queryOutpostConsensusRows(ctx)
    )
  }

  /** The current `sysio.msgch::outpcons` rows (the tip reader's injected query). */
  async function queryOutpostConsensusRows(
    ctx: ClusterBuildContext
  ): Promise<OutpostConsensusRow[]> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.outpcons.query({
        limit: Constants.OutpostConsensusTableReadLimit
      })
    return rows as OutpostConsensusRow[]
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * The contested chain's `sysio.epoch::epochstate` row.
   *
   * @param ctx - The build context.
   * @returns The contested chain's epoch-state row.
   */
  export async function readEpochState(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioEpochEpochStateType> {
    return Steps.contracts.sysio.epoch.readEpochState(ctx, Constants.ContestedChain)
  }

  /**
   * The contested chain's `current_epoch_index`.
   *
   * @param ctx - The build context.
   * @returns The contested chain's current epoch index.
   */
  export async function currentEpoch(
    ctx: ClusterBuildContext
  ): Promise<number> {
    return Number((await readEpochState(ctx)).current_epoch_index)
  }

  /**
   * Whether an outpost chain's epoch is paused (its `epochstate.is_paused`).
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain; the contested one unless named.
   * @returns The chain's pause flag.
   */
  export async function epochPaused(
    ctx: ClusterBuildContext,
    chain: TestClusterConstants.OutpostChainCodename = Constants.ContestedChain
  ): Promise<boolean> {
    return Boolean(
      (await Steps.contracts.sysio.epoch.readEpochState(ctx, chain)).is_paused
    )
  }

  /**
   * Whether a schedule group seats exactly `accounts`, in any order — pure over one
   * `sysio.epoch::epochstate` group.
   *
   * @param group - The group's accounts (absent when the chain has no schedule).
   * @param accounts - The accounts the group must seat, and nothing else.
   * @returns `true` when the group is exactly `accounts`.
   */
  export function isExactGroup(
    group: string[],
    accounts: readonly string[]
  ): boolean {
    return (
      group != null &&
      group.length === accounts.length &&
      accounts.every(account => group.includes(account))
    )
  }

  /**
   * Whether the contested chain's ACTIVE batch-operator group is exactly the dispute operators.
   *
   * @param ctx - The build context.
   * @returns `true` when the ACTIVE group matches {@link SlashingScenarioConstants.DisputeOperators}.
   */
  export async function disputeOperatorsOwnGroup(
    ctx: ClusterBuildContext
  ): Promise<boolean> {
    return isExactGroup(
      await Steps.contracts.sysio.epoch.activeBatchOperatorGroup(
        ctx,
        Constants.ContestedChain
      ),
      disputeOperatorAccounts(ctx)
    )
  }

  /** The dispute operators' chain accounts, resolved from their durable handles via `ctx.keyStore`. */
  function disputeOperatorAccounts(ctx: ClusterBuildContext): string[] {
    return Constants.DisputeOperators.map(
      label => ctx.keyStore.assertOperator(label).account
    )
  }

  /**
   * Every `sysio.msgch::envelopes` row: the inbound deliveries the depot still retains.
   *
   * @param ctx - The build context.
   * @returns The rows.
   * @throws If the read reports more rows than {@link SlashingScenarioConstants.EnvelopeTableReadLimit}.
   */
  export async function readEnvelopes(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioMsgchEnvelopeEntryType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.envelopes.query({ limit: Constants.EnvelopeTableReadLimit })
    Assert.ok(
      !more,
      `sysio.msgch::envelopes holds more than ${Constants.EnvelopeTableReadLimit} rows; the read is truncated`
    )
    return rows
  }

  /**
   * The deliveries of one (outpost, epoch) bucket: the rows of `rows` for `chain`'s
   * `epochIndex`, the set `sysio.msgch::evalcons` tallies.
   *
   * @param rows - `sysio.msgch::envelopes` rows (see {@link readEnvelopes}).
   * @param chain - The outpost chain.
   * @param epochIndex - The chain's epoch.
   * @returns The bucket's rows.
   */
  export function outpostEpochEnvelopes(
    rows: SysioContracts.SysioMsgchEnvelopeEntryType[],
    chain: TestClusterConstants.OutpostChainCodename,
    epochIndex: number
  ): SysioContracts.SysioMsgchEnvelopeEntryType[] {
    return rows.filter(
      row =>
        isPackedCode(row.chain_code, chain) &&
        Number(row.epoch_index) === epochIndex
    )
  }

  /**
   * The operator's row on `sysio.opreg::operators`, by durable `label` handle
   * (resolved to its `account` via `ctx.keyStore`).
   *
   * @param ctx - The build context.
   * @param label - The operator's durable harness `label` handle.
   * @returns The row (absent when the operator is unknown).
   */
  export async function readOperator(
    ctx: ClusterBuildContext,
    label: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const account = ctx.keyStore.assertOperator(label).account,
      { rows } = await ctx.wire
        .getSysioContract(SysioContractName.opreg)
        .tables.operators.query({ limit: Constants.OperatorTableReadLimit })
    return rows.find(row => row.account === account)
  }

  /**
   * The OPEN dispute row for the contested chain's `epochIndex`, if any, read through the
   * `byoutepoch` index (`Steps.contracts.sysio.chalg.readEpochDispute`).
   *
   * @param ctx - The build context.
   * @param epochIndex - The contested chain's contested epoch.
   * @returns The row (absent when no dispute is open for the chain's epoch).
   */
  export async function findOpenDispute(
    ctx: ClusterBuildContext,
    epochIndex: number
  ): Promise<SysioContracts.SysioChalgDisputeEntryType> {
    const dispute = await Steps.contracts.sysio.chalg.readEpochDispute(
      ctx,
      Constants.ContestedChain,
      epochIndex
    )
    return dispute != null &&
      Steps.contracts.sysio.chalg.isOpenDispute(dispute, Constants.ContestedChain, epochIndex)
      ? dispute
      : undefined
  }

  /**
   * The dispute row with `disputeId`, if any.
   *
   * @param ctx - The build context.
   * @param disputeId - The dispute row id.
   * @returns The row (absent when unknown).
   */
  export async function readDispute(
    ctx: ClusterBuildContext,
    disputeId: number
  ): Promise<SysioContracts.SysioChalgDisputeEntryType> {
    return (await Steps.contracts.sysio.chalg.readDisputes(ctx)).find(
      row => Number(row.id) === disputeId
    )
  }

  /**
   * The candidate checksum delivered by `account` — the canonical candidate is
   * the one the canonical operator delivered.
   *
   * @param candidates - The dispute's candidate buckets.
   * @param account - The delivering operator's CHAIN account (dispute rows
   *   carry chain accounts — resolve a durable handle via `ctx.keyStore` first).
   * @returns The checksum (absent when `account` delivered no candidate).
   */
  export function candidateChecksumForOperator(
    candidates: SysioContracts.SysioChalgDisputeCandidateType[],
    account: string
  ): string {
    return candidates.find(candidate => candidate.operators.includes(account))
      ?.checksum
  }

  // There is deliberately NO `crankChkdispute` here. `sysio.chalg::chkdispute` is
  // cranked in PRODUCTION by `batch_operator_plugin`'s epoch tick from every ACTIVE
  // batch operator (wire-sysio `crank_open_disputes`). A flow that cranks the tally
  // itself passes whether or not any operator would, so it cannot detect a missing
  // production crank — and for a dispute that is the difference between "the epoch
  // resumes" and "the epoch stays paused with quorum already reached". This flow's
  // three `dispop.*` are SBP-less, but the bootstrapped batch operators keep their
  // daemons and stay opreg-ACTIVE across the dispute (bootstrapped ops bypass
  // `termcheck`, and a paused epoch runs no `recorddel`), so their plugin tick is
  // what resolves the dispute here.

  /**
   * The chain-clock time left before an epoch boundary (ms): `nextEpochStart` minus the
   * head-block time, negative once the boundary has passed. Chain timestamps are UTC and
   * may omit the zone suffix.
   *
   * @param nextEpochStart - The chain's `epochstate.next_epoch_start`.
   * @param headBlockTime - The chain's `get_info.head_block_time`.
   * @returns The time left (ms); `NaN` when either timestamp does not parse, which passes
   *   no comparison.
   */
  export function msUntilEpochBoundary(
    nextEpochStart: string,
    headBlockTime: string
  ): number {
    return parseUtcMs(nextEpochStart) - parseUtcMs(headBlockTime)
  }

  /** The contested chain's {@link msUntilEpochBoundary}, from its `epochstate` row and the chain head. */
  async function readMsUntilEpochBoundary(
    ctx: ClusterBuildContext
  ): Promise<number> {
    const nextEpochStart = String((await readEpochState(ctx)).next_epoch_start),
      headBlockTime = String((await ctx.wire.getInfo()).head_block_time)
    return msUntilEpochBoundary(nextEpochStart, headBlockTime)
  }

  /**
   * Settle onto the dispute-operators-owned epoch on which the dispute is staged.
   *
   * The contested chain's advance that seated the dispute operators opened their epoch with
   * an empty envelope bucket: the bootstrapped relays delivered for the epoch before it, whose
   * consensus that advance closed, and `deliver` accepts only the current epoch from its
   * active group. With only the SBP-less dispute operators elected, nothing delivers for the
   * new epoch, no consensus forms and the chain FREEZES on it, which is exactly where the
   * divergent split must land. So this waits for the epoch index to hold while the dispute
   * operators own the active group, WITHOUT cranking: no `chkcons` can advance an epoch that
   * no group member delivers to.
   *
   * @param ctx - The build context.
   * @returns The frozen, dispute-operators-owned `current_epoch_index`.
   */
  export async function settleOnDisputeEpoch(
    ctx: ClusterBuildContext
  ): Promise<number> {
    let previousEpoch = -1
    let stableChecks = 0
    await pollUntil(
      "epoch settles (frozen) on the dispute-operators-owned epoch",
      async () => {
        const epoch = await currentEpoch(ctx)
        stableChecks = epoch === previousEpoch ? stableChecks + 1 : 0
        previousEpoch = epoch
        return (
          (await disputeOperatorsOwnGroup(ctx)) &&
          stableChecks >= Constants.SettleStableChecks
        )
      },
      Constants.settleDeadlineMs(),
      Constants.settlePollIntervalMs()
    )
    const epoch = await currentEpoch(ctx)
    log.info(
      `[slashing] settled on frozen dispute-operators-owned epoch ${epoch}`
    )
    return epoch
  }

  // ── Step: sysio.roa::planNodeownreg (write) ───────────────────────────────────

  /** Input for {@link planNodeownreg}. */
  export interface NodeownregInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.NodeownregInput"
    readonly account: string
    readonly tier: NodeOwnerTier
  }

  /**
   * `sysio.roa::nodeownreg` — create and register a fresh Tier-1 voter (the
   * registration inline-bumps `nodecount.t1_count`, the N `chkdispute` reads).
   * The recorded eth key MUST be a `PUB_EM_*` (secp256k1) — a throwaway random
   * EM key per owner satisfies that (it is never signed with).
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param account - Voter account to create; it must not exist yet.
   * @param tier - The node-owner tier.
   * @returns The definition step.
   */
  export function planNodeownreg<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    tier: NodeOwnerTier
  ): ClusterBuildStep<C, NodeownregInput> {
    return ClusterBuildStep.create<C, NodeownregInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.NodeownregInput", account, tier },
      runNodeownreg
    )
  }

  /** Named runner — ONE `sysio.roa::nodeownreg` with a throwaway EM link key. */
  export async function runNodeownreg<C extends ClusterBuildContext>(
    ctx: C,
    input: NodeownregInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const ethereumIdentity = ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
    await pushNodeOwnerReg(
      ctx.wire,
      input.account,
      input.tier,
      ethereumIdentity.address.slice(2).toLowerCase(),
      ethereumIdentity.publicKey,
      TestClusterConstants.DEV_K1_PUBLIC_KEY
    )
  }

  // ── Step: sysio.opreg::planProcessbatch (write) ───────────────────────────────

  /** Input for {@link planProcessbatch} — the operator's `label` handle + account-less action data. */
  export interface ProcessbatchInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.ProcessbatchInput"
    readonly label: string
    readonly data: Omit<SysioContracts.SysioOpregProcessbatchAction, "account">
  }

  /**
   * `sysio.opreg::processbatch` — force a dispute operator ACTIVE. Normally an
   * operator flips UNKNOWN→ACTIVE via `reevaluate_eligibility`, which only
   * fires on a deposit event; the dispute operators post no collateral, so
   * nothing would ever evaluate them. `planProcessbatch(label, was_eligible=false,
   * is_eligible=true)` IS the eligibility callback and flips status directly;
   * it only needs `sysio.opreg` auth (= `sysio@active` = the kiod dev key
   * in-cluster). They carry no bond, which is fine — the flow asserts the
   * SLASHED status flip, not a bond amount.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param label - The operator's durable harness `label` handle (its resolved
   *   `account` is what the action carries).
   * @param data - The generated action data.
   * @returns The definition step.
   */
  export function planProcessbatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    data: Omit<SysioContracts.SysioOpregProcessbatchAction, "account">
  ): ClusterBuildStep<C, ProcessbatchInput> {
    return ClusterBuildStep.create<C, ProcessbatchInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.ProcessbatchInput", label, data },
      runProcessbatch
    )
  }

  /** Named runner — `sysio.opreg::processbatch` for the operator's resolved account. */
  export async function runProcessbatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ProcessbatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.processbatch.invoke({
        ...input.data,
        account: ctx.keyStore.assertOperator(input.label).account
      })
  }

  // ── Step: sysio.msgch::planDeliver (write) ────────────────────────────────────

  /** Input for {@link planDeliver}. */
  export interface DeliverInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.DeliverInput"
    readonly batchOperatorLabel: string
    readonly chainCode: number
    readonly tag: string
  }

  /**
   * `sysio.msgch::deliver` — one operator delivers one tagged envelope for the
   * contested epoch (read from {@link ContestedEpochKey} at run time). The
   * typed `invoke` waits for finality, so the deliver is CONFIRMED to land — a
   * forked-out/dropped deliver would leave fewer than 3 distinct checksums and
   * the dispute would never open.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param batchOperatorLabel - The delivering operator's durable `label`
   *   handle (its resolved `account` signs `@active`).
   * @param chainCode - The outpost's `slug_name` chain code.
   * @param tag - The envelope payload tag (drives the checksum).
   * @returns The definition step.
   */
  export function planDeliver<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperatorLabel: string,
    chainCode: number,
    tag: string
  ): ClusterBuildStep<C, DeliverInput> {
    return ClusterBuildStep.create<C, DeliverInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SlashingScenarioDisputeSteps.DeliverInput",
        batchOperatorLabel,
        chainCode,
        tag
      },
      runDeliver
    )
  }

  /** Named runner — encode the tagged envelope for the contested epoch, deliver it. */
  export async function runDeliver<C extends ClusterBuildContext>(
    ctx: C,
    input: DeliverInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epochIndex = ctx.outputs.assert(ContestedEpochKey)
    // Chain the synthetic envelope from the outpost's current inbound tips so the winner (or, for
    // the non-contested outpost, the consensus envelope) passes SEC-102 validation in
    // apply_consensus: `previous_envelope_hash` continues the envelope chain and
    // `previous_message_id` continues the message chain. The three divergent envelopes for the
    // contested outpost all read the SAME pre-dispute tips; only the voted winner dispatches and
    // advances them.
    const tips = await readInboundTips(ctx, input.chainCode, epochIndex)
    const envelope = encodeTaggedEnvelope({
      epochIndex,
      epochEnvelopeIndex: Constants.EnvelopeEpochEnvelopeIndex,
      epochTimestampMs: Constants.EnvelopeEpochTimestampMs,
      payloadVersion: Constants.EnvelopeVersion,
      tag: input.tag,
      previousMessageId: tips.messageTip,
      previousEnvelopeHash: tips.envelopeDigest
    })
    const batchOperatorAccount = ctx.keyStore.assertOperator(
      input.batchOperatorLabel
    ).account
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.deliver.invoke(
        {
          batch_op_name: batchOperatorAccount,
          chain_code: input.chainCode,
          data: bytesToHex(envelope)
        },
        {
          authorization: [
            { actor: batchOperatorAccount, permission: ActivePermission }
          ]
        }
      )
  }

  // ── Step: sysio.chalg::planVotedispute (write) ────────────────────────────────

  /** Input for {@link planVotedispute}. */
  export interface VotedisputeInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.VotedisputeInput"
    readonly owner: string
  }

  /**
   * `sysio.chalg::votedispute` — one Tier-1 owner votes the canonical checksum
   * of the open dispute (both read from {@link DisputeResolutionKey} at run
   * time), signed `owner@active` with the shared dev K1.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param owner - The voting Tier-1 owner.
   * @returns The definition step.
   */
  export function planVotedispute<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    owner: string
  ): ClusterBuildStep<C, VotedisputeInput> {
    return ClusterBuildStep.create<C, VotedisputeInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.VotedisputeInput", owner },
      runVotedispute
    )
  }

  /** Named runner — ONE `votedispute` for the stored dispute + canonical checksum. */
  export async function runVotedispute<C extends ClusterBuildContext>(
    ctx: C,
    input: VotedisputeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const target = ctx.outputs.assert(DisputeResolutionKey)
    await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .actions.votedispute.invoke(
        {
          owner: input.owner,
          dispute_id: target.disputeId,
          chosen_checksum: target.canonicalChecksum
        },
        {
          authorization: [{ actor: input.owner, permission: ActivePermission }]
        }
      )
  }

  // ── Step: stage the contested epoch (capture) ─────────────────────────────

  /**
   * Capture the settled contested epoch index into {@link ContestedEpochKey} —
   * the epoch every subsequent deliver / dispute read keys on. The index and
   * the active group are read from one `epochstate` row, and the epoch is
   * captured only when the dispute operators alone own its group. No boundary
   * wait: the depot opens a dispute on the delivery after which no version can
   * still win, at any time in the epoch.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planStageContestedEpoch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runStageContestedEpoch
    )
  }

  /** Named runner — store the contested epoch index once the dispute operators own it. */
  export async function runStageContestedEpoch<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = await readEpochState(ctx),
      epoch = Number(state.current_epoch_index),
      activeGroup = state.batch_op_groups?.[state.current_batch_op_group]
    Assert.ok(
      isExactGroup(activeGroup, disputeOperatorAccounts(ctx)),
      `the ${Constants.ContestedChain} epoch ${epoch} is not owned by the dispute operators alone: its active group is ${JSON.stringify(activeGroup)}`
    )
    ctx.outputs.set(ContestedEpochKey, epoch)
    log.info(`[slashing] contested epoch staged: ${epoch}`)
  }

  // ── Step: await headroom before the ACTIVE flips (chain-clock poll) ─────

  /**
   * Poll until the contested chain's clock is at least
   * {@link SlashingScenarioConstants.activationHeadroomMs} short of its
   * `next_epoch_start`. An advance never lands before the boundary, so the
   * dispute operators' ACTIVE flips that follow all land before the same advance.
   * An advance drawing the pool between two flips would seat a group mixing
   * dispute and bootstrapped operators; its dispute operators, which deliver only
   * when the flow injects, would miss that epoch instead of owning it alone.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planAwaitActivationHeadroom<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runAwaitActivationHeadroom
    )
  }

  /** Named runner — poll the contested chain's clock until the headroom before its boundary holds. */
  export async function runAwaitActivationHeadroom<
    C extends ClusterBuildContext
  >(ctx: C, _input: null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const headroomMs = Constants.activationHeadroomMs()
    await pollUntil(
      `the ${Constants.ContestedChain} chain clock is at least ${headroomMs} ms short of next_epoch_start`,
      async () => (await readMsUntilEpochBoundary(ctx)) >= headroomMs,
      Constants.activationHeadroomDeadlineMs(),
      Constants.BoundaryPollIntervalMs
    )
  }

  // ── Step: await the natural advance seating the dispute operators ───────

  /**
   * Poll until the contested chain's ACTIVE group is exactly the dispute
   * operators. Nothing rebuilds the schedule: the chain's window holds one
   * group, and `sysio.epoch::finishadv` re-draws it on every advance from the
   * chain's pool (ACTIVE batch operators SERVING the chain, non-bootstrapped
   * first, then by account). Once the three serving dispute operators are
   * ACTIVE, the next advance, pushed by the bootstrapped relays after their
   * consensus on the epoch then live, seats exactly them.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planAwaitSoleActiveGroup<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runAwaitSoleActiveGroup
    )
  }

  /** Named runner — poll until the contested chain's ACTIVE group is exactly the dispute operators. */
  export async function runAwaitSoleActiveGroup<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pollUntil(
      `the ${Constants.ContestedChain} advance seats the ${Constants.DisputeOperatorCount} dispute operators as its sole active group`,
      () => disputeOperatorsOwnGroup(ctx),
      Constants.groupDeadlineMs(),
      Constants.LongPollIntervalMs
    )
  }

  // ── Step: await the dispute opening (poll + capture the resolution target) ─

  /**
   * Poll until an OPEN dispute row appears for the contested (outpost, epoch),
   * assert it carries a candidate per dispute operator, resolve the canonical
   * candidate's checksum, and store the {@link DisputeResolutionTarget} for the
   * vote + resolve steps.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planAwaitDisputeOpened<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runAwaitDisputeOpened
    )
  }

  /** Named runner — poll for the OPEN dispute, assert candidates, store the target. */
  export async function runAwaitDisputeOpened<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epoch = ctx.outputs.assert(ContestedEpochKey)
    await pollUntil(
      "an OPEN dispute row appears for the contested (outpost, epoch)",
      async () => (await findOpenDispute(ctx, epoch)) != null,
      Constants.disputeOpenDeadlineMs(),
      Constants.LongPollIntervalMs
    )
    const dispute = await findOpenDispute(ctx, epoch)
    Assert.ok(dispute != null, `no OPEN dispute row for epoch ${epoch}`)
    Assert.ok(
      dispute.candidates.length >= Constants.DisputeOperators.length,
      `expected >= ${Constants.DisputeOperators.length} dispute candidates, got ${dispute.candidates.length}`
    )
    const canonicalAccount = ctx.keyStore.assertOperator(
      Constants.CanonicalOperator
    ).account
    const canonicalChecksum = candidateChecksumForOperator(
      dispute.candidates,
      canonicalAccount
    )
    Assert.ok(
      isNotEmpty(canonicalChecksum),
      `no candidate checksum delivered by ${Constants.CanonicalOperator} (${canonicalAccount})`
    )
    ctx.outputs.set(DisputeResolutionKey, {
      disputeId: Number(dispute.id),
      canonicalChecksum
    })
    log.info(
      `[slashing] dispute ${dispute.id} open for epoch ${epoch} — canonical checksum ${canonicalChecksum}`
    )
  }

  // ── Step: await the dispute resolution (production crank, not the harness) ─

  /**
   * Poll until the dispute resolves to the canonical winner. The tally itself is
   * NOT cranked here — `batch_operator_plugin` cranks `sysio.chalg::chkdispute`
   * on its epoch tick, and this step asserts that it does: `chkdispute` records
   * the winner, dispatches the winning envelope via `sysio.msgch::resolvedisp`,
   * whose acceptance of it slashes the non-canonical deliverers, and unpauses the
   * epoch. A timeout here means nothing in production tallied the votes.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planAwaitDisputeResolved<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runAwaitDisputeResolved
    )
  }

  /** Named runner — poll until RESOLVED with the canonical winning checksum. */
  export async function runAwaitDisputeResolved<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const target = ctx.outputs.assert(DisputeResolutionKey)
    await pollUntil(
      "dispute resolves to the canonical winner",
      async () => {
        const dispute = await readDispute(ctx, target.disputeId)
        return (
          dispute != null &&
          matchesProtoEnum(
            dispute.status,
            SysioChalgDisputestatus,
            SysioChalgDisputestatus.DISPUTE_STATUS_RESOLVED
          ) &&
          dispute.winning_checksum === target.canonicalChecksum
        )
      },
      Constants.resolveDeadlineMs(),
      Constants.LongPollIntervalMs
    )
  }

  // ── Step: await an operator slash (pure poll) ─────────────────────────────

  /** Input for {@link planAwaitOperatorSlashed}. */
  export interface AwaitOperatorSlashedInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput"
    readonly label: string
  }

  /**
   * Poll until the operator flips OPERATOR_STATUS_SLASHED. The dispute's
   * resolution slashes it: `sysio.msgch::resolvedisp`, inside the `chkdispute`
   * transaction that records the winner, slashes every deliverer whose envelope
   * differs from it. Nothing is cranked, so the contested chain does not
   * advance meanwhile.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param label - The non-canonical deliverer (by durable harness `label`
   *   handle) expected to be slashed.
   * @returns The definition step.
   */
  export function planAwaitOperatorSlashed<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, AwaitOperatorSlashedInput> {
    return ClusterBuildStep.create<C, AwaitOperatorSlashedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput",
        label
      },
      runAwaitOperatorSlashed
    )
  }

  /** Named runner — poll until the operator row shows SLASHED. */
  export async function runAwaitOperatorSlashed<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitOperatorSlashedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pollUntil(
      `${input.label} (non-canonical) becomes SLASHED`,
      async () => {
        const row = await readOperator(ctx, input.label)
        return (
          row != null &&
          matchesProtoEnum(
            row.status,
            SysioOpregOperatorstatus,
            SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
          )
        )
      },
      Constants.slashDeadlineMs(),
      Constants.LongPollIntervalMs
    )
  }

  // ── Step: await an operator's ACTIVE flip (pure poll) ─────────────────────

  /** Input for {@link planAwaitOperatorActive}. */
  export interface AwaitOperatorActiveInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.AwaitOperatorActiveInput"
    readonly label: string
  }

  /**
   * Poll until the operator flips OPERATOR_STATUS_ACTIVE (after its
   * {@link planProcessbatch} eligibility flip lands).
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param label - The dispute operator (by durable harness `label` handle) expected to flip ACTIVE.
   * @returns The definition step.
   */
  export function planAwaitOperatorActive<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, AwaitOperatorActiveInput> {
    return ClusterBuildStep.create<C, AwaitOperatorActiveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SlashingScenarioDisputeSteps.AwaitOperatorActiveInput",
        label
      },
      runAwaitOperatorActive
    )
  }

  /** Named runner — poll until the operator row shows ACTIVE. */
  export async function runAwaitOperatorActive<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitOperatorActiveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pollUntil(
      `${input.label} is ACTIVE`,
      async () => {
        const row = await readOperator(ctx, input.label)
        return (
          row != null &&
          matchesProtoEnum(
            row.status,
            SysioOpregOperatorstatus,
            SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
          )
        )
      },
      Constants.activeDeadlineMs(),
      Constants.LongPollIntervalMs
    )
  }

  /** Parse a chain timestamp as UTC ms (chain timestamps omit the zone suffix). */
  function parseUtcMs(raw: string): number {
    return Date.parse(
      raw.endsWith(UtcZuluSuffix) ? raw : `${raw}${UtcZuluSuffix}`
    )
  }
}
