import type { SysioContracts } from "@wireio/sdk-core"

/**
 * The emissions ledger at one instant: the T5 treasury state and the emissions readiness gate's
 * block log, read with no economic tick between them.
 */
export interface EconomicClockEmissionsReading {
  /** The `sysio::t5state` row. */
  readonly t5: SysioContracts.SysioSystemT5StateType
  /** The `sysio.epoch::blocklog` rows — the open block episode, or none. */
  readonly blockLog: readonly SysioContracts.SysioEpochBlocklogEntryType[]
}
