import type { SysioContracts } from "@wireio/sdk-core"

/**
 * Complete `sysio.roa::nodeownreg` payload.
 *
 * `@wireio/sdk-core@1.0.90` was published with a stale generated declaration
 * that stops at `wire_pub_key`, although the current contract ABI and SDK
 * source also require `eth_address`. Extending the generated action keeps the
 * compatibility field checked in fresh standalone installs; this interface
 * can be removed once the corrected SDK declaration is published.
 */
export interface NodeOwnerRegistrationAction
  extends SysioContracts.SysioRoaNodeownregAction {
  eth_address: string
}
