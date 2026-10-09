import { CellAlignment } from "@wireio/ql-shared"

import { createTuiStore, KeyBindings, ResultsActions, ResultsGridPanel, TuiAction } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("ResultsGridPanel", () => {
  it("renders the header and rows of the view with the cursor row and cell", () => {
    const store = storeWithResult()
    store.dispatch(ResultsActions.cursorMoved({ rowDelta: 1, columnDelta: 1, rowCount: 3, columnCount: 2 }))
    const renderer = renderTui(<ResultsGridPanel focused height={5} width={80} />, { store })
    expect(textOf(renderer)).toBe(["id │ name ", " 1 │ alice", " 2 │ bob  ", " 3 │ carol"].join("\n"))
    expect(textsWithProp(renderer, "underline").map(instance => instance.props.children)).toEqual(["bob  "])
  })

  it("highlights find hits and shows the empty state", () => {
    const store = storeWithResult()
    store.dispatch(ResultsActions.findTextSet("car"))
    const renderer = renderTui(<ResultsGridPanel focused={false} height={5} width={80} />, { store })
    expect(textsWithProp(renderer, "color").map(instance => instance.props.children)).toEqual(["carol"])
    expect(textOf(renderTui(<ResultsGridPanel focused height={5} width={80} />, { store: createTuiStore() }))).toBe(ResultsGridPanel.EmptyText)
  })

  it("layout math: widths, visible column window, fitting", () => {
    expect(ResultsGridPanel.visibleColumns([10, 10, 10], 2, 23)).toEqual({ start: 1, end: 3 })
    expect(ResultsGridPanel.visibleColumns([10, 10, 10], 0, 100)).toEqual({ start: 0, end: 3 })
    expect(ResultsGridPanel.visibleColumns([50], 0, 10)).toEqual({ start: 0, end: 1 })
    expect(ResultsGridPanel.fit("abcdef", 4, CellAlignment.left)).toBe("abc…")
    expect(ResultsGridPanel.fit("ab", 4, CellAlignment.right)).toBe("  ab")
  })

  it("fits wide characters by display width, stopping at the first that does not fit", () => {
    expect(ResultsGridPanel.fit("中文字符", 5, CellAlignment.left)).toBe("中文…")
    expect(ResultsGridPanel.fit("a中b", 3, CellAlignment.left)).toBe("a… ")
    expect(ResultsGridPanel.fit("中", 2, CellAlignment.left)).toBe("中")
  })

  it("derives the empty text's run key from the bindings", () => {
    expect(ResultsGridPanel.EmptyText).toContain(KeyBindings.labelOf(TuiAction.run))
  })
})
