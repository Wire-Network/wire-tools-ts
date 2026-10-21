import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import {
  ClusterBuildContext,
  ClusterBuildStep,
  InboundTipReader,
  Report,
  Steps,
  WireClient,
  bytesToHex,
  encodeTaggedEnvelope,
  isNotEmpty,
  matchesProtoEnum,
  outputKey,
  pollFor,
  pollUntil,
  type ClusterBuildStepOptions,
  type OutpostInboundTips,
  type StepInput
} from "@wireio/cluster-tool"

import { BatchOperatorDisputeConstants as Constants } from "../batchOperatorDisputeConstants.js"

const { SysioContractName, SysioChalgDisputestatus, SysioOpregOperatorstatus } =
  SysioContracts

const log = getLogger(__filename)

/**
 * Shared semantic steps + dispute-domain reads for batch-operator disputes.
 * Raw ABI writes stay on the canonical `Steps.contracts.sysio.*` palette;
 * this namespace prepares dispute-specific action data from typed cross-step
 * outputs and delegates the write to that palette.
 */
export namespace BatchOperatorDisputeSteps {
  // ── Cross-step output keys ────────────────────────────────────────────────

  /** The frozen, dispute-operators-owned epoch (boundary passed) hosting the divergent split. */
  export const ContestedEpochKey = outputKey<number>(
    "BatchOperatorDisputeScenario.contestedEpoch",
    "the frozen dispute-operators-owned epoch whose boundary has passed"
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
    "BatchOperatorDisputeScenario.disputeResolution",
    "the open dispute's id + the canonical candidate checksum the Tier-1 electorate votes for"
  )

  // ── Envelope encoding + inbound chain tips ────────────────────────────────
  //
  // The canonical OPP codec (semantic-header derivation + tagged-envelope encoding) and the
  // single-flight tip reader live in cluster-tool's shared flow helpers; see those files
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
  ): Promise<SysioContracts.SysioMsgchOutpostConsensusEntryType[]> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.outpcons.query({
        limit: Constants.OutpostConsensusTableReadLimit
      })
    return rows
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * The `sysio.epoch::epochstate` singleton row.
   *
   * @param ctx - The build context.
   * @returns The epoch-state row.
   */
  export async function readEpochState(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioEpochEpochStateType> {
    return Steps.contracts.sysio.epoch.readEpochState(ctx)
  }

  /**
   * The depot's `current_epoch_index`.
   *
   * @param ctx - The build context.
   * @returns The current epoch index.
   */
  export async function currentEpoch(
    ctx: ClusterBuildContext
  ): Promise<number> {
    return Number((await readEpochState(ctx)).current_epoch_index)
  }

  /**
   * Whether the depot epoch is paused (`epochstate.is_paused`).
   *
   * @param ctx - The build context.
   * @returns The pause flag.
   */
  export async function epochPaused(
    ctx: ClusterBuildContext
  ): Promise<boolean> {
    return Boolean((await readEpochState(ctx)).is_paused)
  }

  /**
   * Whether the ACTIVE batch-operator group is exactly the dispute operators.
   *
   * @param ctx - The build context.
   * @returns `true` when the ACTIVE group matches {@link BatchOperatorDisputeConstants.DisputeOperators}.
   */
  export async function disputeOperatorsOwnGroup(
    ctx: ClusterBuildContext
  ): Promise<boolean> {
    const active =
        (await Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx)) ?? [],
      accounts = Constants.DisputeOperators.map(
        label => ctx.keyStore.assertOperator(label).account
      )
    return (
      active.length === accounts.length &&
      accounts.every(account => active.includes(account))
    )
  }

  /**
   * The operator's row on `sysio.opreg::operators`, by durable `label` handle
   * (resolved to its node-owner-generated `account` via `ctx.keyStore`).
   *
   * @param ctx - The build context.
   * @param label - The operator's durable harness `label` handle.
   * @returns The row (absent when the operator is unknown).
   */
  export async function readOperator(
    ctx: ClusterBuildContext,
    label: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const account = ctx.keyStore.assertOperator(label).account
    return (await Steps.contracts.sysio.opreg.readOperators(ctx)).find(
      row => row.account === account
    )
  }

  /**
   * Every `sysio.chalg::disputes` row.
   *
   * @param ctx - The build context.
   * @returns The dispute rows.
   */
  export async function readDisputes(
    ctx: ClusterBuildContext
  ): Promise<SysioContracts.SysioChalgDisputeEntryType[]> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .tables.disputes.query({ limit: Constants.DisputeTableReadLimit })
    return rows
  }

  /**
   * The OPEN dispute row for the contested outpost and `epochIndex`, if any.
   *
   * @param ctx - The build context.
   * @param epochIndex - The contested epoch.
   * @returns The row (absent when no dispute is open for the epoch).
   */
  export async function findOpenDispute(
    ctx: ClusterBuildContext,
    epochIndex: number
  ): Promise<SysioContracts.SysioChalgDisputeEntryType> {
    return (await readDisputes(ctx)).find(
      row =>
        String(row.chain_code) === String(Constants.ContestedChainCode) &&
        Number(row.epoch_index) === epochIndex &&
        matchesProtoEnum(
          row.status,
          SysioChalgDisputestatus,
          SysioChalgDisputestatus.DISPUTE_STATUS_OPEN
        )
    )
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
    return (await readDisputes(ctx)).find(row => Number(row.id) === disputeId)
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
   * Wait until the CHAIN's head-block time is past the current epoch's
   * `next_epoch_start` (plus a margin). Although `chkcons` can re-drive
   * `evalcons` and open a pre-boundary tie after the boundary, this flow waits
   * first so the terminal divergent delivery opens the dispute inline. Gating
   * on the chain clock rather than the runner's wall clock avoids landing that
   * delivery while the chain is still a block or two before the boundary.
   *
   * @param ctx - The build context.
   */
  export async function waitPastEpochBoundary(
    ctx: ClusterBuildContext
  ): Promise<void> {
    await pollUntil(
      "chain head-block time passes next_epoch_start",
      async () => {
        const nextEpochStartMs = WireClient.chainTimeMs(
          String((await readEpochState(ctx)).next_epoch_start)
        )
        const headTimeMs = WireClient.chainTimeMs(
          String((await ctx.wire.getInfo()).head_block_time)
        )
        return (
          Number.isFinite(nextEpochStartMs) &&
          Number.isFinite(headTimeMs) &&
          headTimeMs >= nextEpochStartMs + Constants.EpochBoundaryMarginMs
        )
      },
      Constants.boundaryDeadlineMs(),
      Constants.BoundaryPollIntervalMs
    )
  }

  /**
   * Settle onto the new, dispute-operators-owned epoch on which the dispute
   * is staged.
   *
   * The schedule reshape runs while the genesis epoch is live, whose envelope
   * bucket already holds the bootstrap operators' consistent deliveries (pushed
   * by their cranks before the group swap de-elected them). Those form an
   * Option-B majority, so a divergent split injected at the genesis epoch
   * reaches `evalcons` consensus on the bootstrap checksum instead of opening a
   * dispute. After the swap, the bootstrap operators finish driving the genesis
   * epoch to consensus and `advance` rolls forward to the FIRST fully-post-swap
   * epoch — where only the SBP-less dispute operators are elected, so nothing
   * auto-delivers and the epoch FREEZES. That frozen epoch's contested-outpost
   * bucket is empty, which is exactly where the divergent split must land. So
   * this just waits for the epoch index to stabilise while the dispute
   * operators own the active group — crucially WITHOUT cranking, which would
   * fight the freeze (an SBP-less group has no one to reach consensus, so an
   * advance-off poll can never succeed).
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
      "epoch settles (frozen) on the dispute-operators-owned post-swap epoch",
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
      `[batch-operator-dispute] settled on frozen dispute-operators-owned epoch ${epoch}`
    )
    return epoch
  }

  // ── Step: prepare + submit one tagged dispute envelope ───────────────────

  /** Input for {@link planDeliverTaggedEnvelope}. */
  export interface DeliverTaggedEnvelopeInput extends StepInput {
    readonly kind: "BatchOperatorDisputeSteps.DeliverTaggedEnvelopeInput"
    readonly batchOperatorLabel: string
    readonly chainCode: number
    readonly tag: string
  }

  /**
   * `sysio.msgch::deliver` — one operator delivers one tagged envelope for the
   * contested epoch (read from {@link ContestedEpochKey} at run time). The
   * typed `invoke` waits for finality, so the deliver is CONFIRMED to land — a
   * forked-out/dropped deliver would leave fewer than the topology's expected
   * live candidate count and the dispute would never open.
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
  export function planDeliverTaggedEnvelope<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperatorLabel: string,
    chainCode: number,
    tag: string
  ): ClusterBuildStep<C, DeliverTaggedEnvelopeInput> {
    return ClusterBuildStep.create<C, DeliverTaggedEnvelopeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "BatchOperatorDisputeSteps.DeliverTaggedEnvelopeInput",
        batchOperatorLabel,
        chainCode,
        tag
      },
      runDeliverTaggedEnvelope
    )
  }

  /** Named runner — encode the tagged envelope for the contested epoch, deliver it. */
  export async function runDeliverTaggedEnvelope<C extends ClusterBuildContext>(
    ctx: C,
    input: DeliverTaggedEnvelopeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epochIndex = ctx.outputs.assert(ContestedEpochKey)
    // Chain the synthetic envelope from the outpost's current inbound tips so the winner (or, for
    // the non-contested outpost, the consensus envelope) passes SEC-102 validation in
    // apply_consensus: `previous_envelope_hash` continues the envelope chain and
    // `previous_message_id` continues the message chain. The divergent envelopes for the contested
    // outpost all read the SAME pre-dispute tips; only the voted winner dispatches and advances
    // them.
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
    await Steps.contracts.sysio.msgch.runDeliver(
      ctx,
      {
        kind: "MsgchContractSteps.DeliverInput",
        data: {
          batch_op_name: batchOperatorAccount,
          chain_code: input.chainCode,
          data: bytesToHex(envelope)
        }
      },
      signal
    )
  }

  // ── Step: vote for the stored canonical dispute candidate ────────────────

  /** Input for {@link planVoteCanonicalDispute}. */
  export interface VoteCanonicalDisputeInput extends StepInput {
    readonly kind: "BatchOperatorDisputeSteps.VoteCanonicalDisputeInput"
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
  export function planVoteCanonicalDispute<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    owner: string
  ): ClusterBuildStep<C, VoteCanonicalDisputeInput> {
    return ClusterBuildStep.create<C, VoteCanonicalDisputeInput>(
      actor,
      name,
      description,
      options,
      { kind: "BatchOperatorDisputeSteps.VoteCanonicalDisputeInput", owner },
      runVoteCanonicalDispute
    )
  }

  /** Named runner — ONE `votedispute` for the stored dispute + canonical checksum. */
  export async function runVoteCanonicalDispute<C extends ClusterBuildContext>(
    ctx: C,
    input: VoteCanonicalDisputeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const target = ctx.outputs.assert(DisputeResolutionKey)
    await Steps.contracts.sysio.chalg.runVotedispute(
      ctx,
      {
        kind: "ChalgContractSteps.VotedisputeInput",
        data: {
          owner: input.owner,
          dispute_id: target.disputeId,
          chosen_checksum: target.canonicalChecksum
        }
      },
      signal
    )
  }

  // ── Step: stage the contested epoch (boundary wait + capture) ─────────────

  /**
   * Wait past the settled epoch's boundary ({@link waitPastEpochBoundary}) and
   * capture the contested epoch index into {@link ContestedEpochKey} — the
   * epoch every subsequent deliver / dispute read keys on.
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

  /** Named runner — boundary wait, then store the contested epoch index. */
  export async function runStageContestedEpoch<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await waitPastEpochBoundary(ctx)
    const epoch = await currentEpoch(ctx)
    ctx.outputs.set(ContestedEpochKey, epoch)
    log.info(`[batch-operator-dispute] contested epoch staged: ${epoch}`)
  }

  // ── Step: await the dispute opening (poll + capture the resolution target) ─

  /**
   * Poll until an OPEN dispute row appears for the contested (outpost, epoch),
   * assert it carries a candidate per live delivering operator, resolve the
   * canonical candidate's checksum, and store the
   * {@link DisputeResolutionTarget} for the vote + resolve steps.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param expectedCandidateCount - Number of live operators that delivered a candidate.
   * @returns The definition step.
   */
  export function planAwaitDisputeOpened<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    expectedCandidateCount: number
  ): ClusterBuildStep<C, AwaitDisputeOpenedInput> {
    return ClusterBuildStep.create<C, AwaitDisputeOpenedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
        expectedCandidateCount
      },
      runAwaitDisputeOpened
    )
  }

  /** Input for {@link planAwaitDisputeOpened}. */
  export interface AwaitDisputeOpenedInput extends StepInput {
    readonly kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput"
    /** Number of distinct live delivery candidates expected on the open dispute. */
    readonly expectedCandidateCount: number
  }

  /** Named runner — poll for the OPEN dispute, assert candidates, store the target. */
  export async function runAwaitDisputeOpened<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitDisputeOpenedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epoch = ctx.outputs.assert(ContestedEpochKey)
    const dispute = await pollFor(
      "an OPEN dispute row appears for the contested (outpost, epoch)",
      () => findOpenDispute(ctx, epoch),
      Constants.disputeOpenDeadlineMs(),
      Constants.LongPollIntervalMs
    )
    Assert.ok(
      dispute.candidates.length === input.expectedCandidateCount,
      `expected exactly ${input.expectedCandidateCount} dispute candidates, got ${dispute.candidates.length}`
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
      `[batch-operator-dispute] dispute ${dispute.id} open for epoch ${epoch} — canonical checksum ${canonicalChecksum}`
    )
  }

  // ── Step: await the dispute resolution (production crank, not the harness) ─

  /**
   * Poll until the dispute resolves to the canonical winner. The tally itself is
   * NOT cranked here — `batch_operator_plugin` cranks `sysio.chalg::chkdispute`
   * on its epoch tick, and this step asserts that it does: `chkdispute` records
   * the winner, dispatches the winning envelope via `sysio.msgch::resolvedisp`,
   * and unpauses the epoch. A timeout here means nothing in production tallied
   * the votes.
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

  // ── Step: await an operator slash (read-only poll) ────────────────────────

  /** Input for {@link planAwaitOperatorSlashed}. */
  export interface AwaitOperatorSlashedInput extends StepInput {
    readonly kind: "BatchOperatorDisputeSteps.AwaitOperatorSlashedInput"
    readonly label: string
  }

  /**
   * Poll until the operator flips OPERATOR_STATUS_SLASHED. The slash runs in
   * `sysio.epoch::advance`; the preceding dedicated `chkcons` step drives that
   * advance so this step remains a read-only, reportable assertion.
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
        kind: "BatchOperatorDisputeSteps.AwaitOperatorSlashedInput",
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
    readonly kind: "BatchOperatorDisputeSteps.AwaitOperatorActiveInput"
    readonly label: string
  }

  /**
   * Poll until the operator flips OPERATOR_STATUS_ACTIVE (after its
   * `sysio.opreg::processbatch` eligibility flip lands).
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
        kind: "BatchOperatorDisputeSteps.AwaitOperatorActiveInput",
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
}
