import {
  setStatus,
  uiSlice
} from "@wire-e2e-tests/debugging-client-tool-tui/store/ui/UISlice.js"
import { selectUI } from "@wire-e2e-tests/debugging-client-tool-tui/store/ui/UISelectors.js"
import {
  DefaultStatus,
  SliceName
} from "@wire-e2e-tests/debugging-client-tool-tui/store/StoreTypes.js"

describe("uiSlice", () => {
  it("starts with DefaultStatus", () => {
    const state = uiSlice.reducer(undefined, { type: "@@init" })
    expect(state.status).toBe(DefaultStatus)
  })

  it("setStatus replaces the current status", () => {
    const state = uiSlice.reducer({ status: "old" }, setStatus("new"))
    expect(state.status).toBe("new")
  })
})

describe("selectUI", () => {
  it("returns the UI sub-state keyed by SliceName.UI", () => {
    const state = { [SliceName.UI]: { status: "ready" } } as any
    expect(selectUI(state)).toEqual({ status: "ready" })
  })
})
