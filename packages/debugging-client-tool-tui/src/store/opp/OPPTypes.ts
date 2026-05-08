// Slice-shape types live in shared so the server, the local-disk client,
// and the network client all read from the same definitions. Re-exporting
// here keeps existing TUI imports (`from "../OPPTypes.js"`) working
// without ripple churn.
export type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "@wireio/debugging-shared"

/** OPP slice shape — bounded LRU over epoch index. */
export interface OPPState {
  /** Highest epoch observed across all envelopes. */
  epochIndex: number
  /** Epoch → record. Bounded to {@link OPPState.MaxEpochs}. */
  epochs: Record<number, import("@wireio/debugging-shared").DebugOPPEpochRecord>
  /** Sorted-ascending list of cached epoch indices. Length ≤ `MaxEpochs`. */
  epochOrder: number[]
}

export namespace OPPState {
  /** LRU cap. Changing this affects how many historical epochs stay in memory. */
  export const MaxEpochs = 1_000
}
