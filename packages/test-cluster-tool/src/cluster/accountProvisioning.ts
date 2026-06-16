/**
 * Shared WIRE account-provisioning helpers.
 *
 * Single home for the "create an account + grant it a ROA resource policy"
 * sequence that the cluster bootstrap, the operator-provisioning tool, and
 * flow `beforeAll` blocks all need. Extracted from `ClusterManager.ts`
 * privates so flows reuse one implementation instead of hand-rolling the
 * `createAccount` / `sysio.roa::addpolicy` pair (and its literals) per test.
 */

import { SystemContracts } from "@wireio/sdk-core"
import { Clio, ClioErrorFragment } from "../clients/Clio.js"
import { log } from "../logger.js"
import {
  BOOTSTRAP_NODE_OWNER,
  DEFAULT_RAM_WEIGHT,
  DEFAULT_RESOURCE_WEIGHT
} from "./constants.js"

/**
 * Whether `err` is the chain rejecting an account creation because the name
 * is taken. The "already exists" branch is benign for idempotent
 * provisioning — re-running a flow against an existing cluster directory
 * reuses the account.
 *
 * @param err - The error thrown by a `clio` account-creation call.
 * @returns `true` when the failure is the benign already-exists rejection.
 */
export function isAccountAlreadyExistsError(err: unknown): boolean {
  const anyErr = err as { message?: string; stderr?: string } | null
  const msg = anyErr?.message ?? anyErr?.stderr ?? ""
  return msg.includes(ClioErrorFragment.AccountAlreadyExists)
}

/**
 * Assign a resource allocation policy to an account via `sysio.roa`.
 *
 * @param clio       - Clio wrapper bound to the live cluster.
 * @param owner      - Account receiving the policy.
 * @param issuer     - Node owner issuing the policy (signs as `<issuer>@active`).
 * @param net_weight - NET allocation (sysio.token asset).
 * @param ram_weight - RAM allocation (sysio.token asset).
 * @param cpu_weight - CPU allocation (sysio.token asset).
 */
export async function addResourcePolicy(
  clio: Clio,
  owner: string,
  issuer: string,
  net_weight = DEFAULT_RESOURCE_WEIGHT,
  ram_weight = DEFAULT_RAM_WEIGHT,
  cpu_weight = DEFAULT_RESOURCE_WEIGHT
): Promise<void> {
  await clio.pushActionAndWait<SystemContracts.SysioRoaAddpolicyAction>(
    "sysio.roa",
    "addpolicy",
    {
      owner,
      issuer,
      net_weight,
      ram_weight,
      cpu_weight,
      time_block: 0,
      network_gen: 0
    },
    `${issuer}@active`
  )
}

/**
 * Create an account (owner+active on `ownerKey`), ignoring the benign
 * "already exists" rejection so provisioning stays idempotent across
 * re-runs against an existing cluster directory.
 *
 * @param clio     - Clio wrapper bound to the live cluster.
 * @param account  - Account name to create.
 * @param ownerKey - Public key for both owner and active permissions.
 */
export async function createAccountWithRam(
  clio: Clio,
  account: string,
  ownerKey: string
): Promise<void> {
  try {
    await clio.createAccount("sysio", account, ownerKey, ownerKey)
  } catch (err: unknown) {
    if (!isAccountAlreadyExistsError(err)) {
      const anyErr = err as { message?: string; stderr?: string } | null
      throw new Error(
        `Failed to create account ${account}: ${anyErr?.message ?? anyErr?.stderr ?? err}`
      )
    }
    log.debug(`Account ${account} already exists, continuing`)
  }
}

/**
 * Create an account and assign it a resource policy in one call — the
 * standard provisioning shape for every post-bootstrap test account.
 *
 * @param clio     - Clio wrapper bound to the live cluster.
 * @param account  - Account name to create.
 * @param ownerKey - Public key for both owner and active permissions.
 * @param issuer   - Policy issuer; defaults to {@link BOOTSTRAP_NODE_OWNER}.
 */
export async function createAccountWithResources(
  clio: Clio,
  account: string,
  ownerKey: string,
  issuer: string = BOOTSTRAP_NODE_OWNER
): Promise<void> {
  await createAccountWithRam(clio, account, ownerKey)
  await addResourcePolicy(clio, account, issuer)
}
