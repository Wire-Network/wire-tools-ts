import type { SysioContracts } from "@wireio/sdk-core"
import type { WireEconomicClockTool } from "@wireio/cluster-tool"

/**
 * The emissions hold as first observed: the open block episode, the T5 state it left, both
 * clocks, and the `sysio.msgch::envlog` tip the OPP round trip during the hold must pass.
 */
export interface EconomicClockHoldSnapshot {
  /** The open `blocklog` episode. */
  readonly blockLog: SysioContracts.SysioEpochBlocklogEntryType
  /** The `t5state` row after the held economic epoch. */
  readonly t5: SysioContracts.SysioSystemT5StateType
  /** Both clocks when the hold was observed. */
  readonly reading: WireEconomicClockTool.Reading
  /** The highest `envlog` id when the hold was observed; `0n` for an empty log. */
  readonly envelopeLogTip: bigint
}
