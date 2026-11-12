import { uniq } from "lodash"
import { NestedError, type NestedErrorContext } from "@wireio/shared"
import {
  ABI,
  contracts,
  SignedTransaction,
  SysioContracts,
  Transaction
} from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { getLogger } from "../../../../logging/Logger.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const log = getLogger(__filename)

const { msig } = contracts.sysio

/**
 * Steps for `sysio.msig` actions — multisig governance: a proposer proposes a
 * transaction, the requested permissions approve it, and anyone executes it
 * once the approvals satisfy the transaction's declared authorizations under
 * the authorities in force at execution.
 *
 * Every action is built by sdk-core's msig builders (`contracts.sysio.msig`):
 * `propose` declares `{proposer, sysio.payer}` ahead of the proposer's own
 * permission, so the proposer pays the CPU and NET of carrying the proposed
 * transaction, and the builders encode the proposed transaction whole.
 */
export namespace MsigContractSteps {
  /**
   * Seconds a proposed transaction stays executable after it is proposed.
   * Raising it lets a proposal wait longer for its approvals.
   */
  export const ProposalExpirationSec = 3600
  /** Seconds ahead of head the {@link isExecutable} dry run's header expires. */
  export const DryRunExpirationSec = 60
  /** The refusal `exec` and `propose` report when the approvals cannot authorize the transaction. */
  export const AuthorizationFailedPattern = /transaction authorization failed/

  /**
   * The generated `sysio.msig::propose` data less its encoded `trx`: the
   * proposer, the proposal's name and the permissions asked to approve.
   */
  export type ProposeData = Omit<SysioContracts.SysioMsigProposeAction, "trx">

  /** Input for {@link planPropose} — one `sysio.msig::propose`. */
  export interface ProposeInput extends StepInput {
    readonly kind: "MsigContractSteps.ProposeInput"
    /** The proposer (who also pays), the proposal's name and the requested approvers. */
    readonly data: ProposeData
    /**
     * The proposed transaction's actions, in order, each typed by its own
     * contract; encoded against the deployed ABIs, with a fresh header, when
     * the step runs.
     */
    readonly actions: ReadonlyArray<WireClient.AnyActionPayload>
  }

  /**
   * `sysio.msig::propose` — store `actions` as a transaction for the requested
   * permissions to approve. The contract refuses the proposal when the
   * requested permissions together cannot authorize it.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The proposer (signs `active` and `sysio.payer`), the proposal's name and the requested approvers.
   * @param actions - The proposed transaction's actions.
   * @returns The definition step.
   */
  export function planPropose<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: ProposeData,
    actions: ReadonlyArray<WireClient.AnyActionPayload>
  ): ClusterBuildStep<C, ProposeInput> {
    return ClusterBuildStep.create<C, ProposeInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsigContractSteps.ProposeInput", data, actions },
      runPropose
    )
  }

  /**
   * Named runner — encode the proposed transaction against the deployed ABIs
   * of its contracts, then ONE `sysio.msig::propose`.
   *
   * @param ctx - The build context.
   * @param input - The proposal.
   * @param signal - The step's cancellation.
   */
  export async function runPropose<C extends ClusterBuildContext>(
    ctx: C,
    input: ProposeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.invokeTransaction(await proposeAction(ctx.wire, input))
  }

  /**
   * The encoded `sysio.msig::propose` for `input`: its proposed transaction
   * carries a header taken from the chain now and expiring
   * {@link ProposalExpirationSec} later.
   *
   * @param wire - The WIRE client (reads the header and the ABIs).
   * @param input - The proposal.
   * @returns The encoded action.
   */
  export async function proposeAction(
    wire: WireClient,
    input: ProposeInput
  ): Promise<ReturnType<typeof msig.buildProposeAction>> {
    const contractAccounts = uniq(input.actions.map(action => action.account)),
      abis = await Promise.all(
        contractAccounts.map(async contract => ({
          contract,
          abi: ABI.from((await wire.api.v1.chain.get_abi(contract)).abi)
        }))
      ),
      transaction = await msig.createProposalTransaction(wire.api, {
        actions: input.actions.map(({ account, name, authorization, data }) => ({
          account,
          name,
          authorization: [...authorization],
          data
        })),
        abis,
        expirationSeconds: ProposalExpirationSec
      })
    return msig.buildProposeAction({
      proposer: input.data.proposer,
      proposalName: input.data.proposal_name,
      requested: [...input.data.requested],
      transaction
    })
  }

  /** Input for {@link planApprove} — the generated `sysio.msig::approve` data. */
  export interface ApproveInput extends StepInput {
    readonly kind: "MsigContractSteps.ApproveInput"
    /** The proposal and the approving permission, which signs. */
    readonly data: SysioContracts.SysioMsigApproveAction
  }

  /**
   * `sysio.msig::approve` — record `data.level`'s approval of the proposal.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The proposer, the proposal's name and the approving permission.
   * @returns The definition step.
   */
  export function planApprove<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsigApproveAction
  ): ClusterBuildStep<C, ApproveInput> {
    return ClusterBuildStep.create<C, ApproveInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsigContractSteps.ApproveInput", data },
      runApprove
    )
  }

  /**
   * Named runner — ONE `sysio.msig::approve`, signed by the approving permission.
   *
   * @param ctx - The build context.
   * @param input - The approval.
   * @param signal - The step's cancellation.
   */
  export async function runApprove<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { proposer, proposal_name: proposalName, level, proposal_hash: proposalHash } =
      input.data
    await ctx.wire.invokeTransaction(
      msig.buildApproveAction({ proposer, proposalName, level, proposalHash })
    )
  }

  /** Input for {@link planExec} — the generated `sysio.msig::exec` data. */
  export interface ExecInput extends StepInput {
    readonly kind: "MsigContractSteps.ExecInput"
    /** The proposal and the executing account, which signs `active`. */
    readonly data: SysioContracts.SysioMsigExecAction
  }

  /**
   * `sysio.msig::exec` — run the proposed transaction. The contract refuses it
   * unless the recorded approvals satisfy the transaction's authorizations
   * under the authorities in force NOW, and erases the proposal when it runs.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The proposer, the proposal's name and the executing account.
   * @returns The definition step.
   */
  export function planExec<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsigExecAction
  ): ClusterBuildStep<C, ExecInput> {
    return ClusterBuildStep.create<C, ExecInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsigContractSteps.ExecInput", data },
      runExec
    )
  }

  /**
   * Named runner — ONE `sysio.msig::exec`, signed by the executer.
   *
   * @param ctx - The build context.
   * @param input - The execution.
   * @param signal - The step's cancellation.
   */
  export async function runExec<C extends ClusterBuildContext>(
    ctx: C,
    input: ExecInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.invokeTransaction(execAction(input.data))
  }

  /**
   * The encoded `sysio.msig::exec` for `data`.
   *
   * @param data - The proposer, the proposal's name and the executing account.
   * @returns The encoded action, authorized by `executer@active`.
   */
  export function execAction(
    data: SysioContracts.SysioMsigExecAction
  ): ReturnType<typeof msig.buildExecAction> {
    return msig.buildExecAction({
      proposer: data.proposer,
      proposalName: data.proposal_name,
      executer: data.executer
    })
  }

  /**
   * Whether the proposal would execute NOW — a read: `exec` runs as a dry run
   * ({@link isAuthorized}), which applies the contract's own approval check
   * exactly as a pushed `exec` would and then discards every state change, so
   * the proposal stays open either way.
   *
   * @param wire - The WIRE client.
   * @param data - The execution to try.
   * @returns True when the approvals satisfy the proposal now; false when the
   *   contract refuses it for lack of authorization.
   * @throws NestedError for any other failure of the dry run.
   */
  export async function isExecutable(
    wire: WireClient,
    data: SysioContracts.SysioMsigExecAction
  ): Promise<boolean> {
    return isAuthorized(
      wire,
      execAction(data),
      `dry-run exec of ${data.proposer}/${data.proposal_name}`,
      { proposer: data.proposer, proposalName: data.proposal_name }
    )
  }

  /**
   * Whether `sysio.msig` would accept the proposal NOW — a read: `propose`
   * runs as a dry run ({@link isAuthorized}), which applies the contract's
   * check that the requested permissions together can authorize the proposed
   * transaction, and stores nothing.
   *
   * @param wire - The WIRE client (also reads the header and the ABIs).
   * @param input - The proposal to try.
   * @returns True when the requested permissions could authorize it; false
   *   when the contract refuses it for lack of authorization.
   * @throws NestedError for any other failure of the dry run.
   */
  export async function isProposable(
    wire: WireClient,
    input: ProposeInput
  ): Promise<boolean> {
    return isAuthorized(
      wire,
      await proposeAction(wire, input),
      `dry-run propose of ${input.data.proposer}/${input.data.proposal_name}`,
      { proposer: input.data.proposer, proposalName: input.data.proposal_name }
    )
  }

  /**
   * Run `action` as a dry run (`/v1/chain/compute_transaction`, unsigned),
   * which the node applies and then discards. It answers a failed dry run with
   * its trace's `except` rather than an error.
   *
   * @param wire - The WIRE client.
   * @param action - The encoded msig action.
   * @param label - What the dry run is, for its errors.
   * @param context - The proposal, for its errors.
   * @returns True when the trace was processed without an exception; false
   *   when the contract refuses it for lack of authorization.
   * @throws NestedError for any other failure, including a response that
   *   carries no processed trace.
   */
  async function isAuthorized(
    wire: WireClient,
    action: ReturnType<typeof msig.buildExecAction>,
    label: string,
    context: NestedErrorContext
  ): Promise<boolean> {
    const info = await wire.api.v1.chain.get_info(),
      transaction = Transaction.from({
        ...info.getTransactionHeader(DryRunExpirationSec),
        actions: [action]
      }),
      response = await wire.api.v1.chain
        .compute_transaction(SignedTransaction.from({ ...transaction, signatures: [] }))
        .catch((error: Error) => {
          if (!AuthorizationFailedPattern.test(error.message))
            throw new NestedError(`${label} failed`, { cause: error, context })
          log.debug(`${label}: refused (${error.message})`)
          return null
        })
    if (response == null) return false
    if (response.processed == null)
      throw new NestedError(`${label} returned no processed trace`, { context })
    if (response.processed.except == null) return true
    const refusal = JSON.stringify(response.processed.except)
    if (!AuthorizationFailedPattern.test(refusal))
      throw new NestedError(`${label} failed`, { context: { ...context, refusal } })
    log.debug(`${label}: refused (${refusal})`)
    return false
  }
}
