import { act } from "react"

import { createTuiStore, ResultsActions, TuiModal, UiActions, ValueInspectorModal } from "@wireio/ql-tool-cli/tui/index.js"

import { press, renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("ValueInspectorModal", () => {
  it("inspects the cursor cell and closes on Esc / Enter", () => {
    const store = storeWithResult()
    act(() => {
      store.dispatch(ResultsActions.cursorMoved({ rowDelta: 1, columnDelta: 1, rowCount: 3, columnCount: 2 }))
      store.dispatch(UiActions.modalOpened(TuiModal.inspector))
    })
    const renderer = renderTui(<ValueInspectorModal />, { store })
    expect(textOf(renderer)).toContain("name (text, scalar)\nbob")
    press("", { return: true })
    expect(store.getState().ui.modal).toBe(TuiModal.none)
  })

  it("shows the empty state without a result", () => {
    expect(textOf(renderTui(<ValueInspectorModal />, { store: createTuiStore() }))).toBe(ValueInspectorModal.EmptyText)
  })
})

describe("ValueInspectorModal.KeysHint", () => {
  it("spells Esc and Enter from chords", () => {
    expect(ValueInspectorModal.KeysHint).toBe("Esc / Enter close")
  })
})
