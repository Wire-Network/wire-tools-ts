import { getLogger, NestedError } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../clients/wire/WireClient.js"
import { ClioRunner } from "../../clients/wire/clio/ClioRunner.js"
import { Constants } from "../../Constants.js"

const log = getLogger(__filename)

/**
 * Options for {@link provisionWireUser}.
 */
export interface WireUserOptions {
  /**
   * Raw WIRE base-units (9 decimals) to fund the account with from the
   * `sysio` treasury. `0n` creates the account without funding (e.g. a
   * swap-to-WIRE recipient that only needs to exist).
   */
  fundWireAmount?: bigint
}

/** Result of {@link provisionWireUser}. */
export interface WireUser {
  /** The WIRE account name (1..12 chars, base32 alphabet). */
  account: string
  /**
   * The account name's string-spelling bytes — the canonical
   * `ChainAddress.address` encoding for `CHAIN_KIND_WIRE` recipients
   * (what a swap-to-WIRE `targetRecipient` carries).
   */
  accountBytes: Uint8Array
}

/** Format raw 9-decimal WIRE base units as a sysio asset string. */
export function formatWireAsset(rawAmount: bigint): string {
  const whole = rawAmount / 1_000_000_000n
  const frac = (rawAmount % 1_000_000_000n).toString().padStart(9, "0")
  return `${whole}.${frac} WIRE`
}

/**
 * Provision a WIRE user account for a flow scenario: create the account
 * under the dev K1 key (idempotent across re-runs), attach the standard
 * resource policy from the bootstrap node owner, and optionally fund it
 * with WIRE from the `sysio` treasury.
 *
 * This is flow-layer provisioning (composed from a flow's `beforeAll`),
 * shared here because the WIRE-endpoint swap flows (to-WIRE recipient,
 * from-WIRE depositor, reserve matcher/owner) all need the same shape.
 *
 * @param wire    The cluster's WIRE client (wallet must hold the dev key —
 *                true for every harness-bootstrapped cluster).
 * @param account WIRE account name to provision.
 * @param options Funding options.
 * @return The provisioned account + its ChainAddress byte encoding.
 */
export async function provisionWireUser(
  wire: WireClient,
  account: string,
  options: WireUserOptions = {}
): Promise<WireUser> {
  const { fundWireAmount = 0n } = options

  await wire.wallet.unlock()

  // Account creation — tolerate "already exists" so re-runs are idempotent.
  try {
    await wire.createAccount(
      "sysio",
      account,
      Constants.DEV_K1_PUBLIC_KEY,
      Constants.DEV_K1_PUBLIC_KEY
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(ClioRunner.ErrorFragment.AccountAlreadyExists)) {
      throw new NestedError(
        `provisionWireUser: createAccount(${account}) failed`,
        { cause: err }
      )
    }
    log.debug(`provisionWireUser: account ${account} already exists — reusing`)
  }

  // Resource policy so the account can push its own actions.
  await wire.invoke<SysioContracts.SysioRoaAddpolicyAction>(
    "sysio.roa",
    "addpolicy",
    {
      owner: account,
      issuer: Constants.BOOTSTRAP_NODE_OWNER,
      net_weight: "25.0000 SYS",
      ram_weight: "25.0000 SYS",
      cpu_weight: "25.0000 SYS",
      time_block: 0,
      network_gen: 0
    },
    [{ actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }]
  )

  if (fundWireAmount > 0n) {
    const quantity = formatWireAsset(fundWireAmount)
    await wire.invoke<SysioContracts.SysioTokenTransferAction>(
      "sysio.token",
      "transfer",
      {
        from: "sysio",
        to: account,
        quantity,
        memo: "flow WIRE user funding"
      },
      [{ actor: "sysio", permission: "active" }]
    )
    log.info(`[WireUserTool] funded ${account} with ${quantity}`)
  }

  return {
    account,
    accountBytes: new TextEncoder().encode(account)
  }
}
