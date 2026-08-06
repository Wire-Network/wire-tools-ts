/**
 * UnderwriterSlashingScenarioChallengeSteps — the flow-local Step factories for
 * every `sysio.chalg` underwriter-challenge WRITE this scenario submits
 * (`openuwchal` / `voteuwchal` / `chkuwchal`), plus the plain read helpers the
 * verify steps poll with. Every on-chain write is its own
 * {@link ClusterBuildStep} so the `Report` records it; cross-step values
 * (commitments, challenge ids, bonds, balance baselines) ride `ctx.outputs`
 * under {@link UnderwriterSlashingScenarioOutputs}'s typed keys.
 *
 * Flow-local by the same precedent as `flow-batch-operator-slashing`'s dispute
 * steps: these actions are this scenario's content, not shared harness
 * surface.
 */

import Assert from "node:assert"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  type ClusterBuildStepOptions,
  type OutputKey,
  type Report,
  type StepInput,
  type SwapScenarioContext
} from "@wireio/cluster-tool"
import { UnderwriterSlashingScenarioConstants as Constants } from "../UnderwriterSlashingScenarioConstants.js"
import { UnderwriterSlashingScenarioOutputs as Outputs } from "../UnderwriterSlashingScenarioOutputs.js"

const {
  SysioContractAccount,
  SysioContractName,
  SysioChalgUwchalBallot,
  SysioChalgUwchalVerdict,
  SysioUwritUnderwriterequeststatus
} = SysioContracts

const log = getLogger(__filename)

/** The standard `active` permission every flow-signed action authorizes with. */
const ActivePermission = "active"

export namespace UnderwriterSlashingScenarioChallengeSteps {
  // ── read helpers (plain functions — reads execute freely inside runners) ──

  /**
   * The newest CONFIRMED ETH→SOL uwreq NOT in `excludeUwreqIds` — how the two
   * same-direction swaps are told apart (`ctx.uwreq` matches on direction
   * alone, which is ambiguous once swap B lands).
   *
   * @param ctx - The build context.
   * @param excludeUwreqIds - Uwreq ids already captured (swap A's, for swap B).
   * @returns The commitment, or null while the race is still unresolved.
   */
  export async function findConfirmedCommitment(
    ctx: SwapScenarioContext,
    excludeUwreqIds: readonly number[]
  ): Promise<Outputs.ChallengedCommitment> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.uwreqs.query()
    const row = rows.find(
      request =>
        slugValue(request.src_chain_code) === Constants.EthereumChainCode &&
        slugValue(request.dst_chain_code) === Constants.SolanaChainCode &&
        matchesProtoEnum(
          request.status,
          SysioUwritUnderwriterequeststatus,
          SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
        ) &&
        !excludeUwreqIds.includes(Number(request.id))
    )
    return row == null
      ? null
      : { uwreqId: Number(row.id), underwriterAccount: String(row.winner) }
  }

  /** The `sysio.uwrit::uwreqs` row by id. */
  export async function readUwreq(
    ctx: SwapScenarioContext,
    uwreqId: number
  ): Promise<SysioContracts.SysioUwritUwRequestTType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.uwreqs.query()
    return rows.find(request => Number(request.id) === uwreqId)
  }

  /**
   * The `sysio.chalg::uwchals` row for one challenged commitment (there is at
   * most one, ever — the contract's uniqueness rule).
   */
  export async function readUwchalByCommitment(
    ctx: SwapScenarioContext,
    commitment: Outputs.ChallengedCommitment
  ): Promise<SysioContracts.SysioChalgUwchalEntryType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .tables.uwchals.query()
    return rows.find(
      challenge =>
        Number(challenge.uwreq_id) === commitment.uwreqId &&
        challenge.underwriter === commitment.underwriterAccount
    )
  }

  /** The `sysio.chalg::uwchals` row by id. */
  export async function readUwchal(
    ctx: SwapScenarioContext,
    chalId: number
  ): Promise<SysioContracts.SysioChalgUwchalEntryType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .tables.uwchals.query()
    return rows.find(challenge => Number(challenge.id) === chalId)
  }

  /** The `sysio.opreg::operators` row by ON-CHAIN account name. */
  export async function readOperatorRow(
    ctx: SwapScenarioContext,
    account: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query()
    return rows.find(operator => operator.account === account)
  }

  /**
   * Poll until the challenge reaches `verdict`. The tally, slash, sweep (or
   * hold-clear) and bond payout all ride ONE `chkuwchal` transaction, so once
   * the verdict lands every consequence asserted afterwards is final.
   */
  export async function awaitVerdict(
    ctx: SwapScenarioContext,
    chalId: number,
    verdict: SysioContracts.SysioChalgUwchalVerdict
  ): Promise<void> {
    await pollUntil(
      `challenge ${chalId} reaches verdict ${SysioChalgUwchalVerdict[verdict]}`,
      async () => {
        const challenge = await readUwchal(ctx, chalId)
        return challenge != null && Number(challenge.verdict) === verdict
      },
      Constants.ResolveDeadlineMs,
      Constants.LongPollIntervalMs
    )
  }

  // ── Step: sysio.roa::forcereg (write) ─────────────────────────────────────

  /** Input for {@link planForcereg} — the generated `roa::forcereg` data. */
  export interface ForceregInput extends StepInput {
    readonly kind: "UnderwriterSlashingScenarioChallengeSteps.ForceregInput"
    readonly data: SysioContracts.SysioRoaForceregAction
  }

  /**
   * `sysio.roa::forcereg` — register one Tier-1 voter into the electorate the
   * challenge snapshots. The direct-registration path (no NFT claim): the
   * batch-op slashing flow exercises the full claim registration; this flow's
   * electorate is infrastructure, not the thing under test.
   */
  export function planForcereg(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioRoaForceregAction
  ): ClusterBuildStep<SwapScenarioContext, ForceregInput> {
    return ClusterBuildStep.create<SwapScenarioContext, ForceregInput>(
      actor,
      name,
      description,
      options,
      { kind: "UnderwriterSlashingScenarioChallengeSteps.ForceregInput", data },
      runForcereg
    )
  }

  /** Named runner — one `roa::forcereg` write under `sysio.roa@active`. */
  export async function runForcereg(
    ctx: SwapScenarioContext,
    input: ForceregInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.roa)
      .actions.forcereg.invoke(input.data, {
        authorization: [
          {
            actor: SysioContractAccount[SysioContractName.roa],
            permission: ActivePermission
          }
        ]
      })
  }

  // ── Step: sysio.chalg::openuwchal (write) ─────────────────────────────────

  /** Input for {@link planOpenuwchal} — the allegation's static parameters. */
  export interface OpenuwchalInput extends StepInput {
    readonly kind: "UnderwriterSlashingScenarioChallengeSteps.OpenuwchalInput"
    /** Numeric `underwrite_fault_reason` the challenger alleges. */
    readonly reason: SysioContracts.SysioChalgUnderwriteFaultReason
    /** Free-text evidence context recorded on the challenge row. */
    readonly detail: string
  }

  /** The output keys one challenge phase writes/reads — bundled so both
   *  challenge phases reuse the same factories with their own key set. */
  export interface ChallengeKeys {
    /** The commitment under challenge (set by the capture step). */
    readonly commitment: OutputKey<Outputs.ChallengedCommitment>
    /** Where the opened challenge's row id lands. */
    readonly chalId: OutputKey<number>
    /** Where the escrowed bond amount lands. */
    readonly bond: OutputKey<bigint>
    /** Where the challenger's pre-escrow balance lands. */
    readonly challengerBalanceBefore: OutputKey<bigint>
  }

  /**
   * `sysio.chalg::openuwchal` — file the challenge against the captured
   * commitment. ONE write; the runner then reads back the challenge row it
   * created (id + bond) into `keys`, and asserts the bond actually left the
   * challenger (escrow is an inline transfer inside the same transaction) and
   * that the snapshotted quorum is reachable by the flow's three voters.
   */
  export function planOpenuwchal(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    keys: ChallengeKeys,
    reason: SysioContracts.SysioChalgUnderwriteFaultReason,
    detail: string
  ): ClusterBuildStep<SwapScenarioContext, OpenuwchalInput> {
    return ClusterBuildStep.create<SwapScenarioContext, OpenuwchalInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "UnderwriterSlashingScenarioChallengeSteps.OpenuwchalInput",
        reason,
        detail
      },
      async (ctx, input, signal) => runOpenuwchal(ctx, input, signal, keys)
    )
  }

  /** Named runner body for {@link planOpenuwchal} (keys bound by the factory). */
  export async function runOpenuwchal(
    ctx: SwapScenarioContext,
    input: OpenuwchalInput,
    signal: AbortSignal,
    keys: ChallengeKeys
  ): Promise<void> {
    signal.throwIfAborted()
    const commitment = ctx.outputs.assert(keys.commitment)
    const balanceBefore = await ctx.wire.getWireBalance(
      Constants.ChallengerAccount
    )
    ctx.outputs.set(keys.challengerBalanceBefore, balanceBefore)

    await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .actions.openuwchal.invoke(
        {
          challenger: Constants.ChallengerAccount,
          uwreq_id: commitment.uwreqId,
          underwriter: commitment.underwriterAccount,
          reason: input.reason,
          detail: input.detail
        },
        {
          authorization: [
            { actor: Constants.ChallengerAccount, permission: ActivePermission }
          ]
        }
      )

    const challenge = await readUwchalByCommitment(ctx, commitment)
    Assert.ok(
      challenge != null,
      `openuwchal landed but no uwchals row exists for uwreq ${commitment.uwreqId}`
    )
    const bond = BigInt(challenge.bond_amount)
    Assert.ok(bond > 0n, "the escrowed challenge bond must be positive")
    Assert.strictEqual(
      await ctx.wire.getWireBalance(Constants.ChallengerAccount),
      balanceBefore - bond,
      "the challenger's WIRE drops by exactly the escrowed bond"
    )
    // The flow casts Tier1VoterNames.length identical ballots; a quorum above
    // that means the bootstrap Tier-1 roster grew — fail loudly here instead
    // of deadlocking the vote downstream.
    Assert.ok(
      Number(challenge.quorum) <= Constants.Tier1VoterNames.length,
      `snapshotted quorum ${challenge.quorum} exceeds the flow's ${Constants.Tier1VoterNames.length} voters`
    )
    ctx.outputs.set(keys.chalId, Number(challenge.id)).set(keys.bond, bond)
    log.info(
      `[uwchal] opened challenge ${challenge.id} on uwreq ${commitment.uwreqId} (bond ${bond})`
    )
  }

  // ── Step: sysio.chalg::voteuwchal (write) ─────────────────────────────────

  /** Input for {@link planVoteuwchal}. */
  export interface VoteuwchalInput extends StepInput {
    readonly kind: "UnderwriterSlashingScenarioChallengeSteps.VoteuwchalInput"
    /** The Tier-1 owner casting the ballot. */
    readonly voter: string
    /** Numeric `uwchal_ballot` value. */
    readonly ballot: SysioContracts.SysioChalgUwchalBallot
  }

  /**
   * `sysio.chalg::voteuwchal` — one Tier-1 owner's ballot (record-only on
   * chain; `chkuwchal` tallies). The challenge id is resolved from
   * `ctx.outputs` at run time — it does not exist when the plan is built.
   */
  export function planVoteuwchal(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chalIdKey: OutputKey<number>,
    voter: string,
    ballot: SysioContracts.SysioChalgUwchalBallot
  ): ClusterBuildStep<SwapScenarioContext, VoteuwchalInput> {
    return ClusterBuildStep.create<SwapScenarioContext, VoteuwchalInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "UnderwriterSlashingScenarioChallengeSteps.VoteuwchalInput",
        voter,
        ballot
      },
      async (ctx, input, signal) => runVoteuwchal(ctx, input, signal, chalIdKey)
    )
  }

  /** Named runner body for {@link planVoteuwchal}. */
  export async function runVoteuwchal(
    ctx: SwapScenarioContext,
    input: VoteuwchalInput,
    signal: AbortSignal,
    chalIdKey: OutputKey<number>
  ): Promise<void> {
    signal.throwIfAborted()
    const chalId = ctx.outputs.assert(chalIdKey)
    await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .actions.voteuwchal.invoke(
        { owner: input.voter, chal_id: chalId, ballot: input.ballot },
        {
          authorization: [{ actor: input.voter, permission: ActivePermission }]
        }
      )
    log.info(
      `[uwchal] ${input.voter} voted ${SysioChalgUwchalBallot[input.ballot]} on challenge ${chalId}`
    )
  }

  // ── Step: sysio.chalg::chkuwchal (write — the permissionless tally) ──────

  /** Input for {@link planChkuwchal}. */
  export interface ChkuwchalInput extends StepInput {
    readonly kind: "UnderwriterSlashingScenarioChallengeSteps.ChkuwchalInput"
  }

  /**
   * `sysio.chalg::chkuwchal` — crank the tally right after the deciding vote
   * (production needs no caller: `chklocks` pokes it from the epoch tick; the
   * flow cranks manually for a deterministic, faster resolution — the same
   * relationship `chkdispute` has to its voters).
   */
  export function planChkuwchal(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chalIdKey: OutputKey<number>
  ): ClusterBuildStep<SwapScenarioContext, ChkuwchalInput> {
    return ClusterBuildStep.create<SwapScenarioContext, ChkuwchalInput>(
      actor,
      name,
      description,
      options,
      { kind: "UnderwriterSlashingScenarioChallengeSteps.ChkuwchalInput" },
      async (ctx, input, signal) => runChkuwchal(ctx, input, signal, chalIdKey)
    )
  }

  /** Named runner body for {@link planChkuwchal}. */
  export async function runChkuwchal(
    ctx: SwapScenarioContext,
    input: ChkuwchalInput,
    signal: AbortSignal,
    chalIdKey: OutputKey<number>
  ): Promise<void> {
    signal.throwIfAborted()
    const chalId = ctx.outputs.assert(chalIdKey)
    await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .actions.chkuwchal.invoke(
        { chal_id: chalId },
        {
          authorization: [
            { actor: Constants.ChallengerAccount, permission: ActivePermission }
          ]
        }
      )
  }
}
