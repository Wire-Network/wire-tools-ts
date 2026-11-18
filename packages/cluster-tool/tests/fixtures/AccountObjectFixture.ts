import { API } from "@wireio/sdk-core"

/**
 * `/v1/chain/get_account` responses decoded as sdk-core's `AccountObject`, for
 * tests that read an account's permissions, delegations and action links. Only
 * the permission surface varies; every other field is a fixed placeholder.
 */
export namespace AccountObjectFixture {
  /** The placeholder head block every fixture account reports. */
  export const HeadBlockNum = 1
  /** The placeholder head block time (and code update time). */
  export const HeadBlockTime = "2026-11-10T00:00:00.000"
  /** The placeholder RAM quota, usage and resource limits. */
  export const ResourceValue = 0

  /**
   * One action link: `account::action`, or every action of `account` when no
   * action is named.
   *
   * @param account - The contract account.
   * @param action - The linked action; omitted for a contract-wide link.
   * @returns The decoded link.
   */
  export function link(account: string, action?: string): API.v1.AccountLinkedAction {
    return API.v1.AccountLinkedAction.from({ account, action })
  }

  /**
   * One permission, every key and delegation at weight 1.
   *
   * @param name - The permission.
   * @param parent - Its parent; empty for `owner`.
   * @param threshold - Its threshold.
   * @param keys - Its keys.
   * @param accounts - Its delegations, each spelled `actor@permission`.
   * @param links - The actions linked to it.
   * @returns The decoded permission.
   */
  export function permission(
    name: string,
    parent: string,
    threshold: number,
    keys: string[],
    accounts: string[],
    links: API.v1.AccountLinkedAction[] = []
  ): API.v1.AccountPermission {
    return API.v1.AccountPermission.from({
      perm_name: name,
      parent,
      required_auth: {
        threshold,
        keys: keys.map(key => ({ key, weight: 1 })),
        accounts: accounts.map(level => {
          const [actor, delegated] = level.split("@")
          return { permission: { actor, permission: delegated }, weight: 1 }
        })
      },
      linked_actions: links
    })
  }

  /**
   * An account with `permissions` and, when given, actions linked to `sysio.any`.
   *
   * @param name - The account.
   * @param permissions - Its permissions.
   * @param anyLinks - Its `sysio.any` links; omitted when the response carries none.
   * @returns The decoded account.
   */
  export function account(
    name: string,
    permissions: API.v1.AccountPermission[],
    anyLinks?: API.v1.AccountLinkedAction[]
  ): API.v1.AccountObject {
    const limit = { used: ResourceValue, available: ResourceValue, max: ResourceValue }
    return API.v1.AccountObject.from({
      account_name: name,
      head_block_num: HeadBlockNum,
      head_block_time: HeadBlockTime,
      privileged: false,
      last_code_update: HeadBlockTime,
      ram_quota: ResourceValue,
      net_weight: ResourceValue,
      cpu_weight: ResourceValue,
      net_limit: limit,
      cpu_limit: limit,
      ram_usage: ResourceValue,
      permissions,
      sysio_any_linked_actions: anyLinks
    })
  }
}
