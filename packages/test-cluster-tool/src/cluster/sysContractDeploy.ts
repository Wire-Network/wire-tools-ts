/**
 * Production-path system-contract deployment via sysio.roa::setsyscode / setsysabi.
 *
 * Unlike a raw `clio set contract` (setcode/setabi billed to the account, then a separate setpriv),
 * setsyscode inline-runs setcode + setpriv + giftram and setsysabi inline-runs setabi + giftram, so the
 * contract is deployed privileged with its exact code/abi RAM gifted from the `sysio` pool. This is how
 * production deploys every privileged system contract that lives on its own account (token, msig, wrap,
 * authex, and the OPP set). It cannot target the `sysio` account itself (giftram would self-reference the
 * pool) -- bios/system stay raw -- and it requires ROA to be active and the target account to already exist
 * with a finite, pool-gifted RAM limit (giftram skips unlimited accounts).
 */

import Fs from "fs"
import { ABI, Serializer, SystemContracts } from "@wireio/sdk-core"
import { Clio } from "../clients/Clio.js"

/**
 * Pack a JSON ABI (`abi_def`) into its binary form, returned as a hex string.
 *
 * sysio.roa::setsysabi takes the PACKED `abi_def` (not the JSON text): it inline-sends setabi, whose `abi`
 * argument is the serialized form. clio's `set abi` packs internally, but an inline send must supply the
 * packed bytes, so callers pack here via the antelope serializer.
 *
 * @param abiJson - ABI as a JSON string or already-parsed object.
 * @returns the packed `abi_def` as a lowercase hex string.
 */
export function packAbi(abiJson: string | object): string {
  const obj = typeof abiJson === "string" ? JSON.parse(abiJson) : abiJson
  return Serializer.encode({ object: ABI.from(obj), type: ABI }).hexString
}

/**
 * Deploy a privileged system contract via sysio.roa::setsyscode + setsysabi.
 *
 * @param clio          - Clio client.
 * @param account       - Target system-contract account. Must already exist with a finite (pool-gifted)
 *                        RAM limit; must NOT be the `sysio` account.
 * @param wasmPath      - Path to the compiled `.wasm` (sent as hex `code`).
 * @param abiPath       - Path to the `.abi` JSON (packed via {@link packAbi} for `setsysabi`).
 * @param waitTimeoutMs - Optional override for the in-block wait per action.
 */
export async function deploySysContract(
  clio: Clio,
  account: string,
  wasmPath: string,
  abiPath: string,
  waitTimeoutMs?: number
): Promise<void> {
  const codeHex = Fs.readFileSync(wasmPath).toString("hex")
  const abiHex = packAbi(Fs.readFileSync(abiPath, "utf-8"))

  await clio.pushActionFileAndWait<SystemContracts.SysioRoaSetsyscodeAction>(
    "sysio.roa",
    "setsyscode",
    { account, vmtype: 0, vmversion: 0, code: codeHex },
    "sysio@active",
    waitTimeoutMs
  )
  await clio.pushActionFileAndWait<SystemContracts.SysioRoaSetsysabiAction>(
    "sysio.roa",
    "setsysabi",
    { account, abi: abiHex },
    "sysio@active",
    waitTimeoutMs
  )
}

/**
 * The owner/active authority for a `sysio.*` system account: controlled solely by `sysio@active` (an
 * account-permission authority, no standalone key), so chain governance owns every system account.
 */
export function sysioActiveAuthority() {
  return {
    threshold: 1,
    keys: [] as Array<{ key: string; weight: number }>,
    accounts: [
      { permission: { actor: "sysio", permission: "active" }, weight: 1 }
    ],
    waits: [] as Array<{ wait_sec: number; weight: number }>
  }
}

/** Data shape for the native `sysio::newaccount` action with full authorities. */
interface NewAccountAuthData {
  creator: string
  name: string
  owner: ReturnType<typeof sysioActiveAuthority>
  active: ReturnType<typeof sysioActiveAuthority>
}

/**
 * Create a `sysio.*` system account controlled by `sysio@active`, via `sysio::newaccount`.
 *
 * MUST run after `sysio.system` is deployed AND ROA is active: `system::native::newaccount` then sets the
 * new account to 0 RAM and `transfer_ram(sysio, name, newaccount_ram)` from the pool, so the account is
 * FINITE (never unlimited) and a subsequent {@link deploySysContract} `giftram` can top up its code RAM.
 *
 * @param clio          - Clio client.
 * @param name          - System account name to create.
 * @param waitTimeoutMs - Optional in-block wait override.
 */
export async function createSysioAccount(
  clio: Clio,
  name: string,
  waitTimeoutMs?: number
): Promise<void> {
  const auth = sysioActiveAuthority()
  await clio.pushActionAndWait<NewAccountAuthData>(
    "sysio",
    "newaccount",
    { creator: "sysio", name, owner: auth, active: auth },
    "sysio@active",
    waitTimeoutMs
  )
}
