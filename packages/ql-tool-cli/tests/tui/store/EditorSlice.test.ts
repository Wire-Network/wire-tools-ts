import { CursorMove, EditorActions, EditorSlice, initialEditorState } from "@wireio/ql-tool-cli/tui/index.js"

import { key } from "../../common/inkKeys.js"

describe("EditorSlice", () => {
  it("delegates edits to TextBuffer", () => {
    const reduce = EditorSlice.reducer,
      typed = reduce(initialEditorState, EditorActions.textInserted("SELECT")),
      moved = reduce(typed, EditorActions.cursorMoved(CursorMove.left)),
      deleted = reduce(moved, EditorActions.deletedForward()),
      backed = reduce(deleted, EditorActions.backspaced())
    expect(typed.buffer.text).toBe("SELECT")
    expect(deleted.buffer.text).toBe("SELEC")
    expect(backed.buffer.text).toBe("SELE")
    expect(reduce(backed, EditorActions.undone()).buffer.text).toBe("SELEC")
    expect(reduce(typed, EditorActions.textReplaced("x")).buffer.text).toBe("x")
    expect(reduce(typed, EditorActions.keyApplied({ input: "", key: key({ return: true }) })).buffer.text).toBe("SELECT\n")
  })

  it("ignores edits that change nothing", () => {
    expect(EditorSlice.reducer(initialEditorState, EditorActions.backspaced()).buffer.text).toBe("")
  })
})
