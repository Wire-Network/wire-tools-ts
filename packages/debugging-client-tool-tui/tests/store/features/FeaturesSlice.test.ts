import {
  featuresSlice,
  registerFeature,
  setActiveFeatures
} from "@wire-e2e-tests/debugging-client-tool-tui/store/features/FeaturesSlice.js"
import { selectFeatures } from "@wire-e2e-tests/debugging-client-tool-tui/store/features/FeaturesSelectors.js"
import { SliceName } from "@wire-e2e-tests/debugging-client-tool-tui/store/StoreTypes.js"

describe("featuresSlice", () => {
  it("initial state: empty registered + empty activeIds", () => {
    const state = featuresSlice.reducer(undefined, { type: "@@init" })
    expect(state).toEqual({ registered: [], activeIds: [] })
  })

  it("registerFeature appends once — idempotent on duplicate id", () => {
    const first = featuresSlice.reducer(
      undefined,
      registerFeature({ id: "opp", name: "OPP", core: false })
    )
    expect(first.registered).toHaveLength(1)
    const second = featuresSlice.reducer(
      first,
      registerFeature({ id: "opp", name: "OPP", core: false })
    )
    expect(second.registered).toHaveLength(1)
  })

  it("setActiveFeatures replaces the whole activeIds array", () => {
    const state = featuresSlice.reducer(
      { registered: [], activeIds: ["old"] },
      setActiveFeatures(["process-monitor", "opp"])
    )
    expect(state.activeIds).toEqual(["process-monitor", "opp"])
  })
})

describe("selectFeatures", () => {
  it("returns the full features sub-state", () => {
    const state = {
      [SliceName.Features]: { registered: [], activeIds: ["opp"] }
    } as any
    expect(selectFeatures(state).activeIds).toEqual(["opp"])
  })
})
