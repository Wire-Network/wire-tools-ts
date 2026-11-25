import type { SysioContracts } from "@wireio/sdk-core"
import type { EconomicClockEmissionsReading } from "./EconomicClockEmissionsReading.js"

/**
 * The economic epoch that paid a held period: its `epochlog` row, and the emissions ledger
 * just before and just after its tick.
 */
export interface EconomicClockReleaseSnapshot {
  /** The `sysio::epochlog` row of the paying economic epoch. */
  readonly payout: SysioContracts.SysioSystemEpochLogType
  /** The ledger after the last held economic epoch (the one before the payout). */
  readonly heldBefore: EconomicClockEmissionsReading
  /** The ledger after the paying economic epoch. */
  readonly paidAt: EconomicClockEmissionsReading
}
