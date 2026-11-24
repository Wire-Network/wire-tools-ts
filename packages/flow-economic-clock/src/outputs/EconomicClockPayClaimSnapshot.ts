/**
 * An account's epoch pay at one instant: what it holds, what `payclaims` owes it, and the
 * economic epoch the reading fell in — the record a `claimpay` is measured against.
 */
export interface EconomicClockPayClaimSnapshot {
  /** The account's liquid WIRE (base units). */
  readonly balance: bigint
  /** Its `sysio::payclaims` balance (base units); `0n` when it has no row. */
  readonly payClaim: bigint
  /** `economystate.current_epoch_index` when the snapshot was taken. */
  readonly economicEpochIndex: number
}
