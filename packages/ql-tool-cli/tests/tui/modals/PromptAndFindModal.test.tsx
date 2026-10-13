import { act } from "react"

import { FindModal, PromptModal, ResultsActions, TuiModal, UiActions } from "@wireio/ql-tool-cli/tui/index.js"

import { press, renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("PromptModal", () => {
  it("edits one line; Enter submits, Esc cancels", () => {
    const onSubmit = jest.fn(),
      onCancel = jest.fn(),
      renderer = renderTui(<PromptModal title="Name" initial="x" hint="h" onSubmit={onSubmit} onCancel={onCancel} />, { store: storeWithResult() })
    press("y")
    press("", { return: true })
    expect(textOf(renderer)).toContain("Name\nxy \nh\n")
    expect(onSubmit).toHaveBeenCalledWith("xy")
    press("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })
})

describe("FindModal", () => {
  it("sets the find text, jumps to the first hit and closes", () => {
    const store = storeWithResult()
    act(() => void store.dispatch(UiActions.modalOpened(TuiModal.find)))
    renderTui(<FindModal />, { store })
    ;["c", "a", "r"].forEach(character => press(character))
    press("", { return: true })
    expect(store.getState().results).toMatchObject({ findText: "car", cursorRow: 2 })
    expect(store.getState().ui.modal).toBe(TuiModal.none)
  })

  it("Esc closes without changing the find; no hit keeps the cursor", () => {
    const store = storeWithResult()
    act(() => void store.dispatch(ResultsActions.cursorPlaced(1)))
    renderTui(<FindModal />, { store })
    press("", { escape: true })
    expect(store.getState().results.findText).toBe("")
    renderTui(<FindModal />, { store })
    press("q")
    press("", { return: true })
    expect(store.getState().results.cursorRow).toBe(1)
  })
})

describe("PromptModal.KeysHint", () => {
  it("spells Enter and Esc from chords", () => {
    expect(PromptModal.KeysHint).toBe("Enter accept · Esc cancel")
  })
})
