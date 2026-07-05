import Fs from "node:fs"
import {
  ABI,
  Name,
  type PermissionLevelType,
  Serializer,
  SysioContracts
} from "@wireio/sdk-core"
import type { WireClient } from "../../clients/wire/WireClient.js"

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

  /** Create a `sysio.*` system account governed solely by `sysio@active`. */
  async createSysioAccount(name: string): Promise<void> {
    const authority = WireSysioContractTool.sysioActiveAuthority()
    await this.wire.invoke(
      "sysio",
      "newaccount",
      { creator: "sysio", name, owner: authority, active: authority },
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
        permission: "owner",
        parent: "",
        auth: WireSysioContractTool.sysioActiveCodeAuthority([account])
      },
      [{ actor: account, permission: "owner" }]
    )
  }
}

export namespace WireSysioContractTool {
  /** A permission-weighted authority entry. */
  export interface AuthorityKeyWeight {
    key: string
    weight: number
  }
  /** A permission-level-weighted authority entry. */
  export interface AuthorityWaitWeight {
    wait_sec: number
    weight: number
  }

  /** Pack a JSON `abi_def` into its binary form as a lowercase hex string. */
  export function packAbi(abiJson: string | object): string {
    const object = typeof abiJson === "string" ? JSON.parse(abiJson) : abiJson
    return Serializer.encode({ object: ABI.from(object), type: ABI }).hexString
  }

  /** Authority controlled solely by `sysio@active` (no standalone key). */
  export function sysioActiveAuthority() {
    return {
      threshold: 1,
      keys: [] as AuthorityKeyWeight[],
      accounts: [
        { permission: { actor: "sysio", permission: "active" }, weight: 1 }
      ],
      waits: [] as AuthorityWaitWeight[]
    }
  }

  /**
   * Authority controlled by `sysio@active` PLUS each account's `@sysio.code`
   * permission, sorted by account name value (the chain's required encoding;
   * `sysio` sorts first).
   */
  export function sysioActiveCodeAuthority(codeAccounts: string[]) {
    const accounts = [
      { permission: { actor: "sysio", permission: "active" }, weight: 1 },
      ...codeAccounts.map(actor => ({
        permission: { actor, permission: "sysio.code" },
        weight: 1
      }))
    ].sort((a, b) => {
      const actorA = Name.from(a.permission.actor).value.value,
        actorB = Name.from(b.permission.actor).value.value
      if (actorA !== actorB) return actorA < actorB ? -1 : 1
      const permissionA = Name.from(a.permission.permission).value.value,
        permissionB = Name.from(b.permission.permission).value.value
      return permissionA === permissionB ? 0 : permissionA < permissionB ? -1 : 1
    })
    return {
      threshold: 1,
      keys: [] as AuthorityKeyWeight[],
      accounts,
      waits: [] as AuthorityWaitWeight[]
    }
  }
}
