import { isEqual } from "lodash"
import { match } from "ts-pattern"
import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../clients/wire/WireClient.js"
import { Constants } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { WireSysioContractTool } from "../../tools/wire/WireSysioContractTool.js"
import { supermajorityThreshold } from "../../utils/quorumUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

const log = getLogger(__filename)

const { SysioContractName, SysioContractAccount } = SysioContracts

/**
 * Steps that hand the root `sysio` account to a governance authority — the
 * `sysio.councl`-maintained `sysio.nodes` (the tier-1 node owners) or
 * `sysio.cncl` (the seated council). A handoff is ONE transaction that sets
 * `sysio@active`, then `sysio@owner`, to `<authority>@active`; after it every
 * `sysio` action needs a supermajority of the authority's members, normally
 * through `sysio.msig`.
 */
export namespace GovernanceSteps {
  /** The weight every member of a governance authority carries. */
  export const MemberWeight = 1

  /**
   * The authority `sysio.councl` writes for `members`: each member's `active`
   * at weight {@link MemberWeight}, in chain name order, at
   * {@link supermajorityThreshold}, with no key.
   *
   * @param members - The members, in any order.
   * @returns The authority.
   */
  export function supermajorityAuthority(
    members: ReadonlyArray<string>
  ): SysioContracts.SysioSystemAuthorityType {
    return {
      threshold: supermajorityThreshold(members.length),
      keys: [],
      accounts: [...members]
        .sort(WireSysioContractTool.compareNames)
        .map(actor => ({
          permission: { actor, permission: WireClient.ActivePermission },
          weight: MemberWeight
        }))
    }
  }

  /**
   * The authority of `account@permission` as the chain holds it, in the
   * generated type's spelling ({@link WireClient.toAuthorityType}).
   *
   * @param wire - The WIRE client.
   * @param account - The account.
   * @param permission - The permission.
   * @returns The authority.
   * @throws When the account has no such permission.
   */
  export async function readAuthority(
    wire: WireClient,
    account: string,
    permission: string
  ): Promise<SysioContracts.SysioSystemAuthorityType> {
    const found = (await wire.api.v1.chain.get_account(account)).permissions.find(
      candidate => String(candidate.perm_name) === permission
    )
    if (found == null)
      throw new Error(`${account} has no permission ${permission}`)
    return WireClient.toAuthorityType(found.required_auth)
  }

  /**
   * Refuse a handoff to `authority` while its `active` is still the
   * `sysio.null@active` placeholder it was created with: `sysio.councl` has not
   * written it, and delegating `sysio` to it would leave `sysio` unsatisfiable
   * for good.
   *
   * @param wire - The WIRE client.
   * @param authority - The governance authority account.
   * @throws When the authority's `active` is the placeholder.
   */
  export async function assertAuthorityWritten(
    wire: WireClient,
    authority: Constants.GovernanceAuthorityAccount
  ): Promise<void> {
    const active = await readAuthority(wire, authority, WireClient.ActivePermission)
    if (isEqual(active, WireSysioContractTool.sysioNullActiveAuthority()))
      throw new Error(
        `refusing to hand ${Constants.SYSIO_ACCOUNT} to ${authority}: ${authority}@${WireClient.ActivePermission} is still the unwritten ${Constants.NULL_ACCOUNT}@${WireClient.ActivePermission} placeholder, which would leave ${Constants.SYSIO_ACCOUNT} unsatisfiable`
      )
    log.info(
      `${authority}@${WireClient.ActivePermission} is written: ${active.accounts.length} member(s) at ${active.threshold}`
    )
  }

  /** One action of a handoff transaction, typed by the contract it runs on. */
  export type HandoffAction =
    | WireClient.ActionPayload<SysioContracts.SysioContractName.councl, "syncnodes">
    | WireClient.ActionPayload<SysioContracts.SysioContractName.system, "updateauth">

  /**
   * The `updateauth` that points `sysio@permission` at `authority`, declared
   * by `sysio@owner` (the one permission that may change both).
   *
   * @param authority - The governance authority account.
   * @param permission - `active` or `owner`.
   * @returns The action payload.
   */
  export function repointAction(
    authority: Constants.GovernanceAuthorityAccount,
    permission: typeof WireClient.ActivePermission | typeof WireClient.OwnerPermission
  ): WireClient.ActionPayload<SysioContracts.SysioContractName.system, "updateauth"> {
    return {
      contract: SysioContractName.system,
      account: Constants.SYSIO_ACCOUNT,
      name: "updateauth",
      authorization: [
        { actor: Constants.SYSIO_ACCOUNT, permission: WireClient.OwnerPermission }
      ],
      data: {
        account: Constants.SYSIO_ACCOUNT,
        permission,
        parent:
          permission === WireClient.OwnerPermission
            ? WireClient.OwnerParent
            : WireClient.OwnerPermission,
        auth: WireSysioContractTool.delegatedAuthority(authority)
      }
    }
  }

  /**
   * The actions of the transaction that hands `sysio` to `authority`, in
   * order: for `sysio.nodes`, `sysio.councl::syncnodes` (called by `sysio`)
   * FIRST, so `sysio` lands on the live tier-1 roster even if a supermajority of
   * the previous one rewrote `sysio.nodes@active` by hand; then `sysio@active`,
   * then `sysio@owner`. For `sysio.cncl` only the two repoints — nothing can
   * re-sync the council outside an election.
   *
   * @param authority - The governance authority account.
   * @returns The ordered actions of the one handoff transaction.
   */
  export function handoffActions(
    authority: Constants.GovernanceAuthorityAccount
  ): HandoffAction[] {
    const repoints = [
      repointAction(authority, WireClient.ActivePermission),
      repointAction(authority, WireClient.OwnerPermission)
    ]
    return match(authority)
      .with(Constants.NODE_OWNERS_AUTHORITY, (): HandoffAction[] => [
        {
          contract: SysioContractName.councl,
          account: SysioContractAccount[SysioContractName.councl],
          name: "syncnodes",
          authorization: WireClient.activeAuthorization(Constants.SYSIO_ACCOUNT),
          data: { caller: Constants.SYSIO_ACCOUNT }
        },
        ...repoints
      ])
      .with(Constants.COUNCIL_AUTHORITY, (): HandoffAction[] => repoints)
      .exhaustive()
  }

  /** Input for {@link planHandoff}. */
  export interface HandoffInput extends StepInput {
    readonly kind: "GovernanceSteps.HandoffInput"
    /** The governance authority `sysio` is handed to. */
    readonly authority: Constants.GovernanceAuthorityAccount
    /** The transaction's actions, in order ({@link handoffActions}). */
    readonly actions: HandoffAction[]
  }

  /**
   * Hand `sysio` to `authority` in ONE transaction signed by `sysio`'s current
   * authority ({@link handoffActions}), after {@link assertAuthorityWritten}
   * confirms the authority's `active` is no longer the placeholder.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param authority - The governance authority `sysio` is handed to.
   * @returns The definition step.
   */
  export function planHandoff<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    authority: Constants.GovernanceAuthorityAccount
  ): ClusterBuildStep<C, HandoffInput> {
    return ClusterBuildStep.create<C, HandoffInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "GovernanceSteps.HandoffInput",
        authority,
        actions: handoffActions(authority)
      },
      runHandoff
    )
  }

  /**
   * Named runner — read the authority's `active` and refuse the placeholder,
   * then push the ONE handoff transaction.
   *
   * @param ctx - The build context.
   * @param input - The handoff.
   * @param signal - The step's cancellation.
   */
  export async function runHandoff<C extends ClusterBuildContext>(
    ctx: C,
    input: HandoffInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await assertAuthorityWritten(ctx.wire, input.authority)
    signal.throwIfAborted()
    await ctx.wire.invokeTransaction(...input.actions)
  }
}
