import { createTuiStore, CursorMove, EditorActions, KeyBindings, QueryEditorPanel, TuiAction } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"

describe("QueryEditorPanel", () => {
  it("renders highlighted lines with the cursor when focused", () => {
    const store = createTuiStore()
    store.dispatch(EditorActions.textReplaced("SELECT *\nFROM a.b"))
    const renderer = renderTui(<QueryEditorPanel focused height={4} />, { store })
    expect(textOf(renderer)).toContain("SELECT *\nFROM a.b ")
    expect(textsWithProp(renderer, "inverse").at(-1).props.children).toBe(" ")
  })

  it("shows the first grammar diagnostic, nothing for an empty editor", () => {
    const store = createTuiStore()
    store.dispatch(EditorActions.textReplaced("SELECT FROM"))
    expect(textOf(renderTui(<QueryEditorPanel focused={false} height={4} />, { store }))).toMatch(/1:\d+ /)
    expect(textOf(renderTui(<QueryEditorPanel focused={false} height={4} />, { store: createTuiStore() }))).toBe(`${QueryEditorPanel.Title}\n`)
  })

  it("lineStarts counts code points (the lexer's unit) plus one per line break", () => {
    expect(QueryEditorPanel.lineStarts(["ab", "😀c", ""])).toEqual([0, 3, 6])
    expect(QueryEditorPanel.lineStarts([""])).toEqual([0])
  })

  it("titles the panel with chord labels from the bindings", () => {
    expect(QueryEditorPanel.Title).toBe(`Query  (${KeyBindings.labelOf(TuiAction.run)} run · ${KeyBindings.labelOf(TuiAction.format)} format)`)
  })

  it("puts the cursor on the right cell after a non-BMP character", () => {
    const store = createTuiStore()
    store.dispatch(EditorActions.textReplaced("'😀' x"))
    store.dispatch(EditorActions.cursorMoved(CursorMove.left))
    const renderer = renderTui(<QueryEditorPanel focused height={4} />, { store })
    expect(textsWithProp(renderer, "inverse").map(instance => instance.props.children)).toEqual(["x"])
  })
})
