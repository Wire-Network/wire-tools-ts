import { SystemContracts } from "@wireio/sdk-core"
import type { Clio } from "../clients/Clio.js"
import {
  BOOTSTRAP_NODE_OWNER,
  DEFAULT_RAM_WEIGHT,
  DEFAULT_RESOURCE_WEIGHT,
  DEV_K1_PUBLIC_KEY
} from "../cluster/constants.js"
import { createAccountWithRam } from "../cluster/accountProvisioning.js"
import { log } from "../logger.js"

/** ROA policy weights assigned to a provisioned WIRE user account. */
export interface WireUserResourcePolicy {
  /** NET allocation as a SYS asset string. */
  readonly netWeight: string
  /** RAM allocation as a SYS asset string. */
  readonly ramWeight: string
  /** CPU allocation as a SYS asset string. */
  readonly cpuWeight: string
}

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
  /** Resource policy weights for the account; defaults to standard flow user weights. */
  resourcePolicy?: WireUserResourcePolicy
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
 * @param clio    The cluster's clio wrapper (wallet must hold the dev key —
 *                true for every harness-bootstrapped cluster).
 * @param account WIRE account name to provision.
 * @param options Funding options.
 * @return The provisioned account + its ChainAddress byte encoding.
 */
export async function provisionWireUser(
  clio: Clio,
  account: string,
  options: WireUserOptions = {}
): Promise<WireUser> {
  const fundWireAmount = options.fundWireAmount ?? 0n,
    resourcePolicy = options.resourcePolicy ?? defaultResourcePolicy()

  await clio.walletOpenAndUnlock("default")

  await createAccountWithRam(clio, account, DEV_K1_PUBLIC_KEY)

  // Resource policy so the account can push its own actions.
  await clio.pushActionAndWait<SystemContracts.SysioRoaAddpolicyAction>(
    "sysio.roa",
    "addpolicy",
    {
      owner: account,
      issuer: BOOTSTRAP_NODE_OWNER,
      net_weight: resourcePolicy.netWeight,
      ram_weight: resourcePolicy.ramWeight,
      cpu_weight: resourcePolicy.cpuWeight,
      time_block: 0,
      network_gen: 0
    },
    `${BOOTSTRAP_NODE_OWNER}@active`
  )

  if (fundWireAmount > 0n) {
    const quantity = formatWireAsset(fundWireAmount)
    await clio.pushActionAndWait<SystemContracts.SysioTokenTransferAction>(
      "sysio.token",
      "transfer",
      {
        from: "sysio",
        to: account,
        quantity,
        memo: "flow WIRE user funding"
      },
      "sysio@active"
    )
    log.info(`[WireUserTool] funded ${account} with ${quantity}`)
  }

  return {
    account,
    accountBytes: new TextEncoder().encode(account)
  }
}

function defaultResourcePolicy(): WireUserResourcePolicy {
  return {
    netWeight: DEFAULT_RESOURCE_WEIGHT,
    ramWeight: DEFAULT_RAM_WEIGHT,
    cpuWeight: DEFAULT_RESOURCE_WEIGHT
  }
}
