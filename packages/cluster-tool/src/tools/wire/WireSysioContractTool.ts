import Fs from "node:fs"
import {
  ABI,
  Name,
  type PermissionLevelType,
  Serializer,
  SysioContracts
} from "@wireio/sdk-core"
import { WireClient } from "../../clients/wire/WireClient.js"
import { Constants } from "../../Constants.js"

/** Every system account is governed solely by `sysio@active`. */
const SysioActiveAuthorization: PermissionLevelType[] = [
  { actor: "sysio", permission: "active" }
]

/**
 * Production-path system-contract deployment + system-account creation (folds
 * the former `cluster/sysContractDeploy.ts`). `setsyscode` inline-runs
 * setcode+setpriv+giftram and `setsysabi` inline-runs setabi+giftram, so a
 * privileged contract is deployed with its RAM gifted from the `sysio` pool.
 * Cannot target the `sysio` account itself (bios/system stay raw `set contract`).
 */
export class WireSysioContractTool {
  constructor(private readonly wire: WireClient) {}

  /**
   * Deploy a privileged system contract to `account` via `sysio.roa::setsyscode`
   * + `setsysabi`. The wasm hex goes via {@link WireClient.invokeViaFile} (E2BIG-safe).
   *
   * @param account - Target system-contract account (must exist with finite RAM; not `sysio`).
   * @param wasmPath - Compiled `.wasm` path.
   * @param abiPath - `.abi` JSON path (packed for `setsysabi`).
   */
  async deploySystemContract(
    account: string,
    wasmPath: string,
    abiPath: string
  ): Promise<void> {
    const codeHex = Fs.readFileSync(wasmPath).toString("hex"),
      abiHex = WireSysioContractTool.packAbi(Fs.readFileSync(abiPath, "utf-8"))
    await this.wire.invokeViaFile<SysioContracts.SysioRoaSetsyscodeAction>(
      "sysio.roa",
      "setsyscode",
      { account, vmtype: 0, vmversion: 0, code: codeHex },
      SysioActiveAuthorization
    )
    await this.wire.invokeViaFile<SysioContracts.SysioRoaSetsysabiAction>(
      "sysio.roa",
      "setsysabi",
      { account, abi: abiHex },
      SysioActiveAuthorization
    )
  }

  /**
   * Create a `sysio.*` system account whose `owner` is `sysio@active`.
   *
   * @param name - The account to create.
   * @param active - Its `active` authority: `sysio@active` unless the account's
   *   contract writes it later (a governance authority's
   *   {@link WireSysioContractTool.sysioNullActiveAuthority} placeholder).
   */
  async createSysioAccount(
    name: string,
    active: SysioContracts.SysioSystemAuthorityType = WireSysioContractTool.sysioActiveAuthority()
  ): Promise<void> {
    await this.wire.invoke<SysioContracts.SysioSystemNewaccountAction>(
      Constants.SYSIO_ACCOUNT,
      "newaccount",
      {
        creator: Constants.SYSIO_ACCOUNT,
        name,
        owner: WireSysioContractTool.sysioActiveAuthority(),
        active
      },
      SysioActiveAuthorization
    )
  }

  /**
   * Grant `account` its own `@sysio.code` permission — resets its owner authority
   * to `sysio@active` + `account@sysio.code` so it can inline-send its own
   * actions (epoch advance, evalcons, dispatch, …), kept governed by `sysio@active`.
   */
  async grantSysioCode(account: string): Promise<void> {
    await this.wire.invoke(
      "sysio",
      "updateauth",
      {
        account,
        permission: WireClient.OwnerPermission,
        parent: WireClient.OwnerParent,
        auth: WireSysioContractTool.sysioActiveCodeAuthority([account])
      },
      [{ actor: account, permission: WireClient.OwnerPermission }]
    )
  }
}

export namespace WireSysioContractTool {
  /**
   * The weight and threshold of an authority one delegation satisfies alone; also
   * the weight of each `@sysio.code` grant beside `sysio@active`.
   */
  export const DelegationWeight = 1

  /**
   * The chain's order of two names — by their 64-bit value, the order every
   * authority's entries must follow.
   *
   * @param a - A name.
   * @param b - Another name.
   * @returns Negative, zero or positive, as `Array.sort` expects.
   */
  export function compareNames(a: string, b: string): number {
    const valueA = Name.from(a).value,
      valueB = Name.from(b).value
    return valueA.equals(valueB) ? 0 : valueA.lt(valueB) ? -1 : 1
  }

  /** Pack a JSON `abi_def` into its binary form as a lowercase hex string. */
  export function packAbi(abiJson: string | object): string {
    const object = typeof abiJson === "string" ? JSON.parse(abiJson) : abiJson
    return Serializer.encode({ object: ABI.from(object), type: ABI }).hexString
  }

  /**
   * Authority satisfied by `actor@active` alone: one delegation at weight and
   * threshold {@link DelegationWeight}, no key.
   *
   * @param actor - The account delegated to.
   * @returns The authority.
   */
  export function delegatedAuthority(
    actor: string
  ): SysioContracts.SysioSystemAuthorityType {
    return {
      threshold: DelegationWeight,
      keys: [],
      accounts: [
        {
          permission: { actor, permission: WireClient.ActivePermission },
          weight: DelegationWeight
        }
      ]
    }
  }

  /**
   * Authority controlled solely by `sysio@active` (no standalone key).
   *
   * @returns The authority.
   */
  export function sysioActiveAuthority(): SysioContracts.SysioSystemAuthorityType {
    return delegatedAuthority(Constants.SYSIO_ACCOUNT)
  }

  /**
   * Authority delegating solely to `sysio.null@active` — the genesis account
   * nobody can authorize, so nothing satisfies it. A governance authority
   * account is created with it as `active` until `sysio.councl` writes the
   * members in.
   *
   * @returns The authority.
   */
  export function sysioNullActiveAuthority(): SysioContracts.SysioSystemAuthorityType {
    return delegatedAuthority(Constants.NULL_ACCOUNT)
  }

  /**
   * Authority controlled by `sysio@active` PLUS each account's `@sysio.code`
   * permission, sorted by account name value (the chain's required encoding;
   * `sysio` sorts first).
   *
   * @param codeAccounts - The accounts whose contract code may act through the authority.
   * @returns The authority.
   */
  export function sysioActiveCodeAuthority(
    codeAccounts: string[]
  ): SysioContracts.SysioSystemAuthorityType {
    const accounts = [
      ...sysioActiveAuthority().accounts,
      ...codeAccounts.map(actor => ({
        permission: { actor, permission: WireClient.CodePermission },
        weight: DelegationWeight
      }))
    ].sort(
      (a, b) =>
        compareNames(a.permission.actor, b.permission.actor) ||
        compareNames(a.permission.permission, b.permission.permission)
    )
    return { threshold: DelegationWeight, keys: [], accounts }
  }
}
