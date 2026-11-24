import type { WireEconomicClockTool } from "@wireio/cluster-tool"

/**
 * A queued withdrawal at the instant one of its two waits passed: both clocks, whether the
 * request is still in `sysio.opreg::wtdwqueue`, and the operator's WIRE remit claim — all read
 * while the economic epoch index held still, so they describe one state.
 */
export interface EconomicClockWithdrawalSnapshot {
  /** Both clocks when the wait passed. */
  readonly reading: WireEconomicClockTool.Reading
  /** Whether the request was still queued. */
  readonly queued: boolean
  /** The operator's `remitclaims{account, WIRE}` balance (base units). */
  readonly remitClaim: bigint
}
