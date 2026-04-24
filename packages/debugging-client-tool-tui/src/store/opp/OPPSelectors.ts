import { asOption } from "@3fv/prelude-ts"
import type { RootState } from "../RootState.js"
import { SliceName } from "../StoreTypes.js"
import type { DebugOPPEpochRecord, OPPState } from "./OPPTypes.js"

/** Full OPP slice. */
export const selectOPP = (state: RootState): OPPState => state[SliceName.OPP]

/** Highest cached epoch index (0 when empty). */
export const selectCurrentEpochIndex = (state: RootState): number =>
  state[SliceName.OPP].epochIndex

/** Factory selector: record for a specific epoch, if cached. */
export const selectEpochByIndex =
  (idx: number) =>
  (state: RootState): DebugOPPEpochRecord | undefined =>
    state[SliceName.OPP].epochs[idx]

/** Tail of the LRU — most recent cached epoch. */
export const selectLatestEpoch = (
  state: RootState
): DebugOPPEpochRecord | undefined => {
  const opp = state[SliceName.OPP],
    last = opp.epochOrder[opp.epochOrder.length - 1]
  return asOption(last)
    .map(i => opp.epochs[i])
    .getOrUndefined()
}
