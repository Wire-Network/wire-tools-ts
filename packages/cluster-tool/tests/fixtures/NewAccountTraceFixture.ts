import { type ABI, PublicKey, Serializer, SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { WireAuthorityAuditTool } from "@wireio/cluster-tool/tools/wire"

/**
 * Traced `sysio::newaccount` actions as `/v1/trace_api/get_block` serves them:
 * the encoded `data` always, the node's decoded `params` only when it decoded
 * them. The data is encoded by sdk-core's `Serializer` against {@link Abi}, the
 * serializer that decodes it.
 */
export namespace NewAccountTraceFixture {
  /** The action every fixture traces. */
  export const Action = WireAuthorityAuditTool.NewAccountAction

  /**
   * The system contract ABI's `newaccount` action and the structs it reads, as
   * the deployed `sysio.system.abi` declares them.
   */
  export const Abi: ABI.Def = {
    version: "sysio::abi/1.2",
    types: [],
    structs: [
      {
        name: "permission_level",
        base: "",
        fields: [
          { name: "actor", type: "name" },
          { name: "permission", type: "name" }
        ]
      },
      {
        name: "key_weight",
        base: "",
        fields: [
          { name: "key", type: "public_key" },
          { name: "weight", type: "uint16" }
        ]
      },
      {
        name: "permission_level_weight",
        base: "",
        fields: [
          { name: "permission", type: "permission_level" },
          { name: "weight", type: "uint16" }
        ]
      },
      {
        name: "authority",
        base: "",
        fields: [
          { name: "threshold", type: "uint32" },
          { name: "keys", type: "key_weight[]" },
          { name: "accounts", type: "permission_level_weight[]" }
        ]
      },
      {
        name: Action,
        base: "",
        fields: [
          { name: "creator", type: "name" },
          { name: "name", type: "name" },
          { name: "owner", type: "authority" },
          { name: "active", type: "authority" }
        ]
      }
    ],
    actions: [{ name: Action, type: Action, ricardian_contract: "" }],
    tables: [],
    ricardian_clauses: [],
    variants: [],
    action_results: [],
    enums: []
  }

  /** The key every fixture account's `active` holds, as the chain spells it. */
  export const ActiveKey = PublicKey.from(Constants.DEV_K1_PUBLIC_KEY).toString()

  /**
   * `sysio`'s creation of `name`: its `owner` delegating to `sysio@active`, its
   * `active` holding {@link ActiveKey}.
   *
   * @param name - The new account.
   * @returns The action's data.
   */
  export function data(name: string): SysioContracts.SysioSystemNewaccountAction {
    return {
      creator: Constants.SYSIO_ACCOUNT,
      name,
      owner: {
        threshold: 1,
        keys: [],
        accounts: [
          {
            permission: {
              actor: Constants.SYSIO_ACCOUNT,
              permission: WireClient.ActivePermission
            },
            weight: 1
          }
        ]
      },
      active: { threshold: 1, keys: [{ key: ActiveKey, weight: 1 }], accounts: [] }
    }
  }

  /**
   * `sysio`'s creation of `name` as a node that did not decode it serves it:
   * the encoded data and no `params`.
   *
   * @param name - The new account.
   * @param receiver - The account whose code ran it: `sysio`, or a notified one.
   * @returns The traced action.
   */
  export function raw(
    name: string,
    receiver: string = Constants.SYSIO_ACCOUNT
  ): WireClient.TraceAction {
    return {
      receiver,
      account: Constants.SYSIO_ACCOUNT,
      name: Action,
      data: Serializer.encode({ object: data(name), type: Action, abi: Abi }).hexString
    }
  }

  /**
   * `sysio`'s creation of `name` as a node that decoded it serves it: the
   * encoded data and its `params`.
   *
   * @param name - The new account.
   * @param receiver - The account whose code ran it: `sysio`, or a notified one.
   * @returns The traced action.
   */
  export function decoded(
    name: string,
    receiver: string = Constants.SYSIO_ACCOUNT
  ): WireClient.TraceAction {
    return { ...raw(name, receiver), params: data(name) }
  }
}
