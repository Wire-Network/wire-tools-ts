import { SysioContracts } from "@wireio/sdk-core"
import { outputKey } from "@wireio/cluster-tool"

/** The intake watch's held evidence and the follow-up watch's payment observation. */
export interface HeldObservation {
  /** Number of captured held readings. */
  readonly heldReadings: number
  /** Wall-clock time of the first held reading. */
  readonly firstHeldAt: string
  /** Wall-clock time of the last held reading. */
  readonly lastHeldAt: string
  /** The first bond row as first read unpaid. */
  readonly firstBond: SysioContracts.SysioBondBondRowType
  /** The first bond row as read paid, ending the watch. */
  readonly paidBond: SysioContracts.SysioBondBondRowType
  /** Wall-clock time of the paid reading. */
  readonly paidAt: string
  /** First request approval time on chain. */
  readonly firstResolvedAt: string
}

/** Intake evidence retained when payment precedes the follow-up watch. */
export const InitialHeld = outputKey<HeldObservation>(
  "pluginUnderwritingCap.initialHeld",
  "Second request held at intake before the first bond's payment"
)
