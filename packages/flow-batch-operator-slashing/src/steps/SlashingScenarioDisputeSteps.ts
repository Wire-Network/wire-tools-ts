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
  matchesProtoEnum,
  outputKey,
  pollUntil,
  pushNewNamedUser,
  pushNodeOwnerReg,
  Report,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { bytesToHex, encodeTaggedEnvelope, parseChainTip } from "../EnvelopeCanonicalCodec.js"
import { SingleFlightCache } from "../SingleFlightCache.js"
import { SlashingScenarioConstants as Constants } from "../SlashingScenarioConstants.js"

const {
  SysioContractName,
  SysioChalgDisputestatus,
  SysioOpregOperatorstatus
} = SysioContracts

const log = getLogger(__filename)

/** The permission every flow-pushed action signs with. */
const ActivePermission = "active"
/** ISO-8601 Zulu suffix — chain timestamps are UTC; append when missing. */
const UtcZuluSuffix = "Z"

/**
 * Flow-local step factories + dispute-domain reads for the slashing scenario.
 * The `sysio.chalg` actions (`votedispute`, `chkdispute`), `sysio.msgch::deliver`,
 * `sysio.opreg::processbatch`, and the roa node-owner registration pair have no
 * shared `Steps.*` palette factories yet, so this namespace supplies them in the
 * same shape (`(actor, name, description, options, ...args) → ClusterBuildStep`,
 * ABI-exact action names, typed `StepInput`s, named runners). Cross-step values
 * (the contested epoch, the open dispute's id + canonical checksum) ride
 * `ctx.outputs` via the typed keys below.
 */
export namespace SlashingScenarioDisputeSteps {
  // ── Cross-step output keys ────────────────────────────────────────────────

  /** The frozen, dispute-operators-owned epoch (boundary passed) hosting the divergent split. */
  export const ContestedEpochKey = outputKey<number>(
    "SlashingScenario.contestedEpoch",
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
    "SlashingScenario.disputeResolution",
    "the open dispute's id + the canonical candidate checksum the Tier-1 electorate votes for"
  )

  // ── Envelope encoding + inbound chain tips ────────────────────────────────
  //
  // The canonical OPP codec (semantic-header derivation + tagged-envelope encoding) lives in
  // ../EnvelopeCanonicalCodec.ts so it can be unit-tested without this step module's cluster-tool
  // dependency; see that file for why the checksums are computed over a field-complete canonical
  // encoding rather than protobuf-ts `toBinary`.

  /** The outpost's inbound chain tips from `sysio.msgch::outpcons`, read once per contested epoch. */
  export interface OutpostInboundTips {
    /**
     * The inbound MESSAGE tip: the raw 32-byte `message_id` the next accepted
     * message must carry in `previous_message_id` (SEC-102 replay guard). Empty
     * at stream genesis: no row yet, or an all-zero tip (the depot leaves
     * `message_tip` zero until the first message-bearing envelope is accepted).
     */
    messageTip: Uint8Array
    /**
     * The inbound ENVELOPE tip: `outpcons.envelope_digest`, the canonical epoch
     * digest the next envelope must carry in `previous_envelope_hash`.
     * `apply_consensus` checks this BEFORE the semantic-header validation and
     * drops any non-genesis envelope that does not continue it, so a headerless
     * (empty) prev-hash is dropped once bootstrap has established a tip. Empty at
     * genesis.
     */
    envelopeDigest: Uint8Array
  }

  /**
   * Cache of each outpost's inbound tips per `${chainCode}:${epochIndex}`, so all deliveries an
   * outpost receives for one contested epoch chain from the SAME pre-delivery tips. The cache is
   * SINGLE-FLIGHT ({@link SingleFlightCache}): the three per-operator deliveries run in parallel, so
   * without it each would issue its own read, and once the non-contested outpost's 2/3 majority
   * triggers `apply_consensus` inline and advances the tips, a late read would produce a
   * differently-chained (and so differently-checksummed) envelope — mis-classified as a divergent
   * delivery and wrongly slashed. Registering the in-flight read synchronously collapses the
   * parallel misses onto one read that observes the pre-delivery tips.
   */
  const inboundTipsCache = new SingleFlightCache<string, OutpostInboundTips>()

  /**
   * The outpost's current inbound message + envelope tips from `sysio.msgch::outpcons`, read once
   * per `(chainCode, epochIndex)` and shared across that epoch's parallel deliveries (see
   * {@link inboundTipsCache}). By the time this scenario runs, bootstrap emissions have advanced
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
    return inboundTipsCache.get(`${chainCode}:${epochIndex}`, () =>
      fetchOutpostInboundTips(ctx, chainCode)
    )
  }

  /** Read + parse one outpost's `outpcons` row into its inbound tips (the cache's fetch). */
  async function fetchOutpostInboundTips(
    ctx: ClusterBuildContext,
    chainCode: number
  ): Promise<OutpostInboundTips> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.outpcons.query({ limit: Constants.OutpostConsensusTableReadLimit })
    // `message_tip` / `envelope_digest` are new in the deployed ABI (SEC-102) but absent from the
    // pinned SystemContractTypes, so read them off the runtime row.
    const row = rows.find(r => String(r.chain_code) === String(chainCode)) as
      | { message_tip?: string; envelope_digest?: string }
      | undefined
    return {
      messageTip: parseChainTip(row?.message_tip),
      envelopeDigest: parseChainTip(row?.envelope_digest)
    }
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
    const { rows } = await ctx.wire.getEpochState()
    return rows[0]
  }

  /**
   * The depot's `current_epoch_index`.
   *
   * @param ctx - The build context.
   * @returns The current epoch index.
   */
  export async function currentEpoch(ctx: ClusterBuildContext): Promise<number> {
    return Number((await readEpochState(ctx)).current_epoch_index)
  }

  /**
   * Whether the depot epoch is paused (`epochstate.is_paused`).
   *
   * @param ctx - The build context.
   * @returns The pause flag.
   */
  export async function epochPaused(ctx: ClusterBuildContext): Promise<boolean> {
    return Boolean((await readEpochState(ctx)).is_paused)
  }

  /**
   * Whether the ACTIVE batch-operator group is exactly the dispute operators.
   *
   * @param ctx - The build context.
   * @returns `true` when `batch_op_groups[0]` matches {@link SlashingScenarioConstants.DisputeOperators}.
   */
  export async function disputeOperatorsOwnGroup(ctx: ClusterBuildContext): Promise<boolean> {
    const state = await readEpochState(ctx)
    const active = state?.batch_op_groups?.[0] ?? []
    return (
      active.length === Constants.DisputeOperators.length &&
      Constants.DisputeOperators.every(operator => active.includes(operator))
    )
  }

  /**
   * The operator's row on `sysio.opreg::operators`.
   *
   * @param ctx - The build context.
   * @param account - The operator account.
   * @returns The row (absent when the operator is unknown).
   */
  export async function readOperator(
    ctx: ClusterBuildContext,
    account: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query({ limit: Constants.OperatorTableReadLimit })
    return rows.find(row => row.account === account)
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
   * The OPEN dispute row for `epochIndex`, if any.
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
   * @param account - The delivering operator.
   * @returns The checksum (absent when `account` delivered no candidate).
   */
  export function candidateChecksumForOperator(
    candidates: SysioContracts.SysioChalgDisputeCandidateType[],
    account: string
  ): string {
    return candidates.find(candidate => candidate.operators.includes(account))?.checksum
  }

  // ── Cranks (permissionless writes driven inside polls) ───────────────────

  /**
   * Crank consensus: `sysio.msgch::chkcons` (permissionless, no args) re-runs
   * `evalcons` for the current epoch's outposts and drives epoch advance. With
   * the dispute operators SBP-less, nothing else cranks it, so the flow does —
   * to drive the post-resolution `advance` where the slash runs. Tolerant of
   * transient errors (e.g. chkcons racing a concurrent advance / a forked-out
   * crank) so it is safe to call inside a poll — but NEVER silently: a
   * persistent crank failure (the original `tx_duplicate` bug) is only
   * diagnosable if it is logged. The typed `invoke` waits for finality, spacing
   * repeated cranks so byte-identical empty-data txs don't collide on TAPOS.
   *
   * @param ctx - The build context.
   */
  export async function crankChkcons(ctx: ClusterBuildContext): Promise<void> {
    try {
      await ctx.wire
        .getSysioContract(SysioContractName.msgch)
        .actions.chkcons.invoke(
          {},
          {
            authorization: [
              { actor: Constants.CanonicalOperator, permission: ActivePermission }
            ]
          }
        )
    } catch (error) {
      log.warn(`[slashing] chkcons crank transient: ${errorMessage(error)}`)
    }
  }

  /**
   * Crank the permissionless dispute tally (`sysio.chalg::chkdispute`) — called
   * in a poll loop until the votes are tallied and the dispute resolves.
   * Expected-transient failures (already resolving/resolved) are logged at
   * debug, never swallowed silently.
   *
   * @param ctx - The build context.
   * @param disputeId - The dispute to tally.
   */
  export async function crankChkdispute(
    ctx: ClusterBuildContext,
    disputeId: number
  ): Promise<void> {
    try {
      await ctx.wire
        .getSysioContract(SysioContractName.chalg)
        .actions.chkdispute.invoke(
          { dispute_id: disputeId },
          {
            authorization: [
              { actor: Constants.CanonicalOperator, permission: ActivePermission }
            ]
          }
        )
    } catch (error) {
      log.debug(`[slashing] chkdispute transient: ${errorMessage(error)}`)
    }
  }

  /**
   * Wait until the CHAIN's head-block time is past the current epoch's
   * `next_epoch_start` (plus a margin). A dispute opens only from a deliver
   * whose ON-CHAIN block time is ≥ `next_epoch_start` (`chkcons` can't open
   * one), and the SBP-less dispute group never reaches consensus so the epoch
   * stays put. Gating on the chain clock rather than the runner's wall clock
   * avoids the race where the runner is past the boundary but the chain is a
   * block or two behind, landing the divergent deliver pre-boundary so no
   * dispute ever opens.
   *
   * @param ctx - The build context.
   */
  export async function waitPastEpochBoundary(ctx: ClusterBuildContext): Promise<void> {
    await pollUntil(
      "chain head-block time passes next_epoch_start",
      async () => {
        const nextEpochStartMs = parseUtcMs(String((await readEpochState(ctx)).next_epoch_start))
        const headTimeMs = parseUtcMs(String((await ctx.wire.getInfo()).head_block_time))
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
   * Option-B majority, so a 3-way divergent split injected at the genesis epoch
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
  export async function settleOnDisputeEpoch(ctx: ClusterBuildContext): Promise<number> {
    let previousEpoch = -1
    let stableChecks = 0
    await pollUntil(
      "epoch settles (frozen) on the dispute-operators-owned post-swap epoch",
      async () => {
        const epoch = await currentEpoch(ctx)
        stableChecks = epoch === previousEpoch ? stableChecks + 1 : 0
        previousEpoch = epoch
        return (await disputeOperatorsOwnGroup(ctx)) && stableChecks >= Constants.SettleStableChecks
      },
      Constants.settleDeadlineMs(),
      Constants.settlePollIntervalMs()
    )
    const epoch = await currentEpoch(ctx)
    log.info(`[slashing] settled on frozen dispute-operators-owned epoch ${epoch}`)
    return epoch
  }

  // ── Step: sysio.roa::planNewnameduser (write) ─────────────────────────────────

  /** Input for {@link planNewnameduser}. */
  export interface NewnameduserInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.NewnameduserInput"
    readonly account: string
    readonly tier: NodeOwnerTier
  }

  /**
   * `sysio.roa::newnameduser` — create a voter account under the shared dev K1
   * key (so the flow can sign votes as any owner), exactly as the depot
   * inline-sends it for an NFT claim.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param account - The voter account to create (Tier-1 names are 2-6 chars).
   * @param tier - The node-owner tier.
   * @returns The definition step.
   */
  export function planNewnameduser<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    tier: NodeOwnerTier
  ): ClusterBuildStep<C, NewnameduserInput> {
    return ClusterBuildStep.create<C, NewnameduserInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.NewnameduserInput", account, tier },
      runNewnameduser
    )
  }

  /** Named runner — ONE `sysio.roa::newnameduser` keyed by the dev K1. */
  export async function runNewnameduser<C extends ClusterBuildContext>(
    ctx: C,
    input: NewnameduserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pushNewNamedUser(
      ctx.wire,
      input.account,
      TestClusterConstants.DEV_K1_PUBLIC_KEY,
      input.tier
    )
  }

  // ── Step: sysio.roa::planNodeownreg (write) ───────────────────────────────────

  /** Input for {@link planNodeownreg}. */
  export interface NodeownregInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.NodeownregInput"
    readonly account: string
    readonly tier: NodeOwnerTier
  }

  /**
   * `sysio.roa::nodeownreg` — register the voter as a Tier-1 node owner (the
   * registration inline-bumps `nodecount.t1_count`, the N `chkdispute` reads).
   * The recorded eth key MUST be a `PUB_EM_*` (secp256k1) — a throwaway random
   * EM key per owner satisfies that (it is never signed with).
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param account - The voter account (created by {@link planNewnameduser}).
   * @param tier - The node-owner tier.
   * @returns The definition step.
   */
  export function planNodeownreg<C extends ClusterBuildContext = ClusterBuildContext>(
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
    await pushNodeOwnerReg(
      ctx.wire,
      input.account,
      input.tier,
      ethereumKeyPairFromWallet(ethers.Wallet.createRandom()).publicKey,
      TestClusterConstants.DEV_K1_PUBLIC_KEY
    )
  }

  // ── Step: sysio.opreg::planProcessbatch (write) ───────────────────────────────

  /** Input for {@link planProcessbatch} — the generated `opreg::processbatch` data. */
  export interface ProcessbatchInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.ProcessbatchInput"
    readonly data: SysioContracts.SysioOpregProcessbatchAction
  }

  /**
   * `sysio.opreg::processbatch` — force a dispute operator ACTIVE. Normally an
   * operator flips UNKNOWN→ACTIVE via `reevaluate_eligibility`, which only
   * fires on a deposit event; the dispute operators post no collateral, so
   * nothing would ever evaluate them. `planProcessbatch(account, was_eligible=false,
   * is_eligible=true)` IS the eligibility callback and flips status directly;
   * it only needs `sysio.opreg` auth (= `sysio@active` = the kiod dev key
   * in-cluster). They carry no bond, which is fine — the flow asserts the
   * SLASHED status flip, not a bond amount.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param data - The generated action data.
   * @returns The definition step.
   */
  export function planProcessbatch<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregProcessbatchAction
  ): ClusterBuildStep<C, ProcessbatchInput> {
    return ClusterBuildStep.create<C, ProcessbatchInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.ProcessbatchInput", data },
      runProcessbatch
    )
  }

  /** Named runner — `sysio.opreg::processbatch` (default `sysio.opreg@active` auth). */
  export async function runProcessbatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ProcessbatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.processbatch.invoke(input.data)
  }

  // ── Step: sysio.msgch::planDeliver (write) ────────────────────────────────────

  /** Input for {@link planDeliver}. */
  export interface DeliverInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.DeliverInput"
    readonly batchOperator: string
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
   * @param batchOperator - The delivering operator (signs `@active`).
   * @param chainCode - The outpost's `slug_name` chain code.
   * @param tag - The envelope payload tag (drives the checksum).
   * @returns The definition step.
   */
  export function planDeliver<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    batchOperator: string,
    chainCode: number,
    tag: string
  ): ClusterBuildStep<C, DeliverInput> {
    return ClusterBuildStep.create<C, DeliverInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.DeliverInput", batchOperator, chainCode, tag },
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
    await ctx.wire.getSysioContract(SysioContractName.msgch).actions.deliver.invoke(
      {
        batch_op_name: input.batchOperator,
        chain_code: input.chainCode,
        data: bytesToHex(envelope)
      },
      {
        authorization: [{ actor: input.batchOperator, permission: ActivePermission }]
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
  export function planVotedispute<C extends ClusterBuildContext = ClusterBuildContext>(
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
    await ctx.wire.getSysioContract(SysioContractName.chalg).actions.votedispute.invoke(
      {
        owner: input.owner,
        dispute_id: target.disputeId,
        chosen_checksum: target.canonicalChecksum
      },
      { authorization: [{ actor: input.owner, permission: ActivePermission }] }
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
  export function planStageContestedEpoch<C extends ClusterBuildContext = ClusterBuildContext>(
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
    log.info(`[slashing] contested epoch staged: ${epoch}`)
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
  export function planAwaitDisputeOpened<C extends ClusterBuildContext = ClusterBuildContext>(
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
    const canonicalChecksum = candidateChecksumForOperator(
      dispute.candidates,
      Constants.CanonicalOperator
    )
    Assert.ok(
      isNotEmpty(canonicalChecksum),
      `no candidate checksum delivered by ${Constants.CanonicalOperator}`
    )
    ctx.outputs.set(DisputeResolutionKey, {
      disputeId: Number(dispute.id),
      canonicalChecksum
    })
    log.info(
      `[slashing] dispute ${dispute.id} open for epoch ${epoch} — canonical checksum ${canonicalChecksum}`
    )
  }

  // ── Step: await the dispute resolution (crank chkdispute inside the poll) ─

  /**
   * Poll until the dispute resolves to the canonical winner, re-cranking the
   * permissionless tally ({@link crankChkdispute}) each iteration until the
   * votes are tallied and it resolves. `chkdispute` records the winner,
   * dispatches the winning envelope via `sysio.msgch::resolvedisp`, and
   * unpauses the epoch.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @returns The definition step.
   */
  export function planAwaitDisputeResolved<C extends ClusterBuildContext = ClusterBuildContext>(
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

  /** Named runner — crank + poll until RESOLVED with the canonical winning checksum. */
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
        await crankChkdispute(ctx, target.disputeId)
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

  // ── Step: await an operator slash (crank chkcons inside the poll) ─────────

  /** Input for {@link planAwaitOperatorSlashed}. */
  export interface AwaitOperatorSlashedInput extends StepInput {
    readonly kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput"
    readonly account: string
  }

  /**
   * Poll until `account` flips OPERATOR_STATUS_SLASHED. The slash runs in
   * `sysio.epoch::advance`; `chkcons` drives advance and the SBP-less group
   * means nothing else cranks it, so each iteration cranks
   * ({@link crankChkcons}) until the unpaused epoch advances.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param account - The non-canonical deliverer expected to be slashed.
   * @returns The definition step.
   */
  export function planAwaitOperatorSlashed<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, AwaitOperatorSlashedInput> {
    return ClusterBuildStep.create<C, AwaitOperatorSlashedInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.AwaitOperatorSlashedInput", account },
      runAwaitOperatorSlashed
    )
  }

  /** Named runner — crank + poll until the operator row shows SLASHED. */
  export async function runAwaitOperatorSlashed<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitOperatorSlashedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pollUntil(
      `${input.account} (non-canonical) becomes SLASHED`,
      async () => {
        await crankChkcons(ctx)
        const row = await readOperator(ctx, input.account)
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
    readonly account: string
  }

  /**
   * Poll until `account` flips OPERATOR_STATUS_ACTIVE (after its
   * {@link planProcessbatch} eligibility flip lands).
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param account - The dispute operator expected to flip ACTIVE.
   * @returns The definition step.
   */
  export function planAwaitOperatorActive<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, AwaitOperatorActiveInput> {
    return ClusterBuildStep.create<C, AwaitOperatorActiveInput>(
      actor,
      name,
      description,
      options,
      { kind: "SlashingScenarioDisputeSteps.AwaitOperatorActiveInput", account },
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
      `${input.account} is ACTIVE`,
      async () => {
        const row = await readOperator(ctx, input.account)
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

  /** The chain-side reason folded into a caught error, for crank logging. */
  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Parse a chain timestamp as UTC ms (chain timestamps omit the zone suffix). */
  function parseUtcMs(raw: string): number {
    return Date.parse(raw.endsWith(UtcZuluSuffix) ? raw : `${raw}${UtcZuluSuffix}`)
  }
}
