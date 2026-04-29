import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  appendEnvelope,
  clear,
  hydrate,
  oppSlice
} from "@wireio/debugging-client-tool-tui/store/opp/OPPSlice.js"
import {
  OPPState,
  type DebugOPPEnvelopeRecord
} from "@wireio/debugging-client-tool-tui/store/opp/OPPTypes.js"
import {
  selectAllEpochsDescending,
  selectCurrentEpochIndex,
  selectEpochByNumber,
  selectLatestEpoch,
  selectOPP
} from "@wireio/debugging-client-tool-tui/store/opp/OPPSelectors.js"
import { SliceName } from "@wireio/debugging-client-tool-tui/store/StoreTypes.js"

/** Build a plain envelope record for test dispatches. */
function makeRecord(
  checksum: string,
  endpointsType: DebugOutpostEndpointsType = DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
  receivedAt: number = 0
): DebugOPPEnvelopeRecord {
  return {
    checksum,
    endpointsType,
    envelope: { epochIndex: 0 } as any,
    metadata: { batchOpNames: ["op-a"] } as any,
    receivedAt
  }
}

describe("oppSlice", () => {
  it("initial state: empty epochs map + empty order", () => {
    const state = oppSlice.reducer(undefined, { type: "@@init" })
    expect(state).toEqual({ epochIndex: 0, epochs: {}, epochOrder: [] })
  })

  it("appendEnvelope creates a new epoch record and tracks order", () => {
    const state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 5, record: makeRecord("aaaa") })
    )
    expect(state.epochIndex).toBe(5)
    expect(state.epochOrder).toEqual([5])
    expect(state.epochs[5].envelopes).toHaveLength(1)
  })

  it("appendEnvelope inserts older epochs in sorted order (via match -1 vs index)", () => {
    let state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 10, record: makeRecord("a") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 5, record: makeRecord("b") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 7, record: makeRecord("c") })
    )
    expect(state.epochOrder).toEqual([5, 7, 10])
    expect(state.epochIndex).toBe(10)
  })

  it("appendEnvelope dedupes on (checksum, endpointsType)", () => {
    let state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 1, record: makeRecord("dup") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 1, record: makeRecord("dup") })
    )
    expect(state.epochs[1].envelopes).toHaveLength(1)
  })

  it("appendEnvelope keeps different checksums in same epoch", () => {
    let state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 1, record: makeRecord("aa") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 1, record: makeRecord("bb") })
    )
    expect(state.epochs[1].envelopes).toHaveLength(2)
  })

  it("appendEnvelope evicts oldest when over MaxEpochs", () => {
    let state = oppSlice.reducer(undefined, { type: "@@init" })
    for (let i = 0; i < OPPState.MaxEpochs + 3; i++) {
      state = oppSlice.reducer(
        state,
        appendEnvelope({ epoch: i, record: makeRecord(`cs-${i}`) })
      )
    }
    expect(state.epochOrder).toHaveLength(OPPState.MaxEpochs)
    // first three epochs (0, 1, 2) were evicted
    expect(state.epochOrder[0]).toBe(3)
    expect(state.epochs[0]).toBeUndefined()
    expect(state.epochs[2]).toBeUndefined()
  })

  it("hydrate bulk-loads and sorts + evicts in one pass", () => {
    const records = Array.from({ length: OPPState.MaxEpochs + 5 }, (_, i) => ({
      epoch: OPPState.MaxEpochs + 5 - i - 1, // reverse order
      envelopes: [makeRecord(`cs-${i}`)]
    }))
    const state = oppSlice.reducer(undefined, hydrate(records))
    expect(state.epochOrder).toHaveLength(OPPState.MaxEpochs)
    expect(state.epochOrder[0]).toBeLessThan(
      state.epochOrder[state.epochOrder.length - 1]
    )
    // The newest epoch (MaxEpochs + 4) must survive
    expect(state.epochOrder[state.epochOrder.length - 1]).toBe(
      OPPState.MaxEpochs + 4
    )
  })

  it("clear resets everything", () => {
    let state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 1, record: makeRecord("x") })
    )
    state = oppSlice.reducer(state, clear())
    expect(state).toEqual({ epochIndex: 0, epochs: {}, epochOrder: [] })
  })
})

describe("OPPSelectors", () => {
  const populated = oppSlice.reducer(
    undefined,
    appendEnvelope({ epoch: 42, record: makeRecord("z") })
  )

  it("selectOPP returns the full slice", () => {
    const root = { [SliceName.OPP]: populated } as any
    expect(selectOPP(root)).toBe(populated)
  })

  it("selectCurrentEpochIndex returns the tracked max", () => {
    expect(selectCurrentEpochIndex({ [SliceName.OPP]: populated } as any)).toBe(
      42
    )
  })

  it("selectLatestEpoch returns the tail of epochOrder", () => {
    const latest = selectLatestEpoch({ [SliceName.OPP]: populated } as any)
    expect(latest?.epoch).toBe(42)
  })

  it("selectLatestEpoch is undefined when cache empty", () => {
    const empty = oppSlice.reducer(undefined, { type: "@@init" })
    expect(selectLatestEpoch({ [SliceName.OPP]: empty } as any)).toBeUndefined()
  })

  it("selectAllEpochsDescending returns epochs newest-first", () => {
    let state = oppSlice.reducer(
      undefined,
      appendEnvelope({ epoch: 5, record: makeRecord("a") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 7, record: makeRecord("b") })
    )
    state = oppSlice.reducer(
      state,
      appendEnvelope({ epoch: 3, record: makeRecord("c") })
    )
    const all = selectAllEpochsDescending({ [SliceName.OPP]: state } as any)
    expect(all.map(r => r.epoch)).toEqual([7, 5, 3])
  })

  it("selectEpochByNumber returns the cached record or undefined", () => {
    expect(
      selectEpochByNumber(42)({ [SliceName.OPP]: populated } as any)?.epoch
    ).toBe(42)
    expect(
      selectEpochByNumber(99)({ [SliceName.OPP]: populated } as any)
    ).toBeUndefined()
  })
})
