import { act } from "react"

import { ColumnsModal, ResultsState, TuiAction, TuiModal, UiActions, createTuiStore, selectResultView } from "@wireio/ql-tool-cli/tui/index.js"

import { sampleResult } from "../../common/engineFixtures.js"
import { key } from "../../common/inkKeys.js"
import { press, renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("ColumnsModal", () => {
  it("lists the columns, hides / shows with Space, shows all with a, closes on Enter", () => {
    const store = storeWithResult()
    act(() => void store.dispatch(UiActions.modalOpened(TuiModal.columns)))
    const renderer = renderTui(<ColumnsModal />, { store })
    expect(textOf(renderer)).toContain(`${ColumnsModal.ShownMark} id  integer`)
    press(" ")
    expect(store.getState().results.hiddenColumns).toEqual(["id"])
    expect(textOf(renderer)).toContain(`${ColumnsModal.HiddenMark} id`)
    expect(selectResultView(store.getState().results).columns.map(column => column.name)).toEqual(["name"])
    press("", { downArrow: true })
    press(" ")
    expect(store.getState().results.hiddenColumns).toEqual(["id"])
    expect(store.getState().ui.messages.at(-1).text).toBe(ColumnsModal.LastColumnWarning)
    press("", { upArrow: true })
    press(" ")
    expect(store.getState().results.hiddenColumns).toEqual([])
    press("", { downArrow: true })
    press(" ")
    press("a")
    expect(store.getState().results.hiddenColumns).toEqual([])
    press("", { return: true })
    expect(store.getState().ui.modal).toBe(TuiModal.none)
  })

  it("Esc closes; without a result the list is empty and Space is a no-op", () => {
    const store = createTuiStore()
    act(() => void store.dispatch(UiActions.modalOpened(TuiModal.columns)))
    renderTui(<ColumnsModal />, { store })
    press(" ")
    expect(store.getState().results.hiddenColumns).toEqual([])
    press("", { escape: true })
    expect(store.getState().ui.modal).toBe(TuiModal.none)
  })

  it("rowText marks shown and hidden columns", () => {
    const [id] = sampleResult().columns
    expect(ColumnsModal.rowText(id, [])).toBe(`${ColumnsModal.ShownMark} id  integer`)
    expect(ColumnsModal.rowText(id, ["id"])).toBe(`${ColumnsModal.HiddenMark} id  integer`)
  })

  it("handleKey routes arrows to the cursor and ignores unbound input", () => {
    const store = storeWithResult(),
      moves: number[] = [],
      context = { dispatch: store.dispatch, columns: ResultsState.success(store.getState().results).result.columns, hiddenColumns: [] }
    ColumnsModal.handleKey({ action: TuiAction.none, input: "", key: key({ upArrow: true }) }, "id", context, delta => moves.push(delta))
    ColumnsModal.handleKey({ action: TuiAction.none, input: "", key: key({ downArrow: true }) }, "id", context, delta => moves.push(delta))
    ColumnsModal.handleKey({ action: TuiAction.none, input: "q", key: key() }, "id", context, delta => moves.push(delta))
    expect(moves).toEqual([-1, 1])
    expect(store.getState().results.hiddenColumns).toEqual([])
    ColumnsModal.toggle(undefined, context)
    expect(store.getState().results.hiddenColumns).toEqual([])
  })
})

describe("ColumnsModal.KeysHint", () => {
  it("spells ↑↓, Space, the show-all input, Enter and Esc from chords", () => {
    expect(ColumnsModal.KeysHint).toBe("↑↓ move · Space show/hide · a show all · Enter/Esc close")
  })
})
