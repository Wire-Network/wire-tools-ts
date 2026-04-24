import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { asOption } from "@3fv/prelude-ts"
import { identity } from "lodash"
import { match } from "ts-pattern"
import { SliceName } from "../StoreTypes.js"
import {
  OPPState,
  type DebugOPPEnvelopeRecord,
  type DebugOPPEpochRecord
} from "./OPPTypes.js"

const initialState: OPPState = { epochIndex: 0, epochs: {}, epochOrder: [] }

/**
 * Insert `epoch` into an ascending-sorted `order` list via functional branching.
 * `findIndex` returns `-1` when `epoch` is greater than every existing entry, in
 * which case it is appended; otherwise it's spliced in at the first larger index.
 *
 * @param order ascending list of epoch indices; mutated in place
 * @param epoch epoch index to insert
 */
function insertEpoch(order: number[], epoch: number): void {
  const idx = order.findIndex(e => e > epoch)
  match(idx)
    .with(-1, () => {
      order.push(epoch)
    })
    .otherwise(i => {
      order.splice(i, 0, epoch)
    })
}

/**
 * Evict oldest epochs until `state.epochOrder.length ≤ OPPState.MaxEpochs`.
 * Runs 0 or 1 time per `appendEnvelope`, but can run N times during a bulk
 * `hydrate` after a fresh scan.
 */
function evictExcess(state: OPPState): void {
  const excess = state.epochOrder.length - OPPState.MaxEpochs
  if (excess <= 0) return
  const dropped = state.epochOrder.splice(0, excess)
  dropped.forEach(d => {
    delete state.epochs[d]
  })
}

/** Payload for {@link appendEnvelope} — one `(epoch, record)` pair. */
export interface AppendEnvelopePayload {
  epoch: number
  record: DebugOPPEnvelopeRecord
}

/** OPP slice — bounded LRU of decoded envelope records, per epoch. */
export const oppSlice = createSlice({
  name: SliceName.OPP,
  initialState,
  reducers: {
    /**
     * Add one envelope record; creates the epoch entry if absent; evicts when
     * over cap. Deduplicates on `(endpointsType, checksum)` — same pair is a
     * no-op.
     */
    appendEnvelope: (state, action: PayloadAction<AppendEnvelopePayload>) => {
      const { epoch, record } = action.payload
      const epochRecord: DebugOPPEpochRecord = asOption(state.epochs[epoch]).match({
        Some: identity,
        None: () => {
          const fresh: DebugOPPEpochRecord = { epoch, envelopes: [] }
          state.epochs[epoch] = fresh
          insertEpoch(state.epochOrder, epoch)
          evictExcess(state)
          return fresh
        }
      })
      const duplicate = epochRecord.envelopes.some(
        e =>
          e.checksum === record.checksum &&
          e.endpointsType === record.endpointsType
      )
      if (!duplicate) epochRecord.envelopes.push(record)
      if (epoch > state.epochIndex) state.epochIndex = epoch
    },
    /** Bulk-replace cache from initial directory scan. */
    hydrate: (state, action: PayloadAction<DebugOPPEpochRecord[]>) => {
      action.payload.forEach(rec => {
        state.epochs[rec.epoch] = rec
        if (!state.epochOrder.includes(rec.epoch))
          state.epochOrder.push(rec.epoch)
        if (rec.epoch > state.epochIndex) state.epochIndex = rec.epoch
      })
      state.epochOrder.sort((a, b) => a - b)
      evictExcess(state)
    },
    /** Drop all cache — used when the selected cluster changes. */
    clear: state => {
      state.epochIndex = 0
      state.epochs = {}
      state.epochOrder = []
    }
  }
})

export const { appendEnvelope, hydrate, clear } = oppSlice.actions
