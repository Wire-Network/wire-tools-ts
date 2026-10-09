import { CursorMove, TextBuffer } from "@wireio/ql-tool-cli/tui/index.js"

import { key } from "../../common/inkKeys.js"

describe("TextBuffer", () => {
  it("inserts, deletes, moves and undoes", () => {
    const typed = TextBuffer.insert(TextBuffer.insert(TextBuffer.create(), "SELEC"), "T"),
      deleted = TextBuffer.backspace(typed),
      moved = TextBuffer.move(deleted, CursorMove.left)
    expect(typed).toMatchObject({ text: "SELECT", cursor: 6 })
    expect(deleted).toMatchObject({ text: "SELEC", cursor: 5 })
    expect(TextBuffer.deleteForward(moved)).toMatchObject({ text: "SELE", cursor: 4 })
    expect(TextBuffer.undo(deleted)).toMatchObject({ text: "SELECT", cursor: 6 })
    expect(TextBuffer.replace(typed, "X")).toMatchObject({ text: "X", cursor: 1 })
  })

  it("moves across multi-line text by line and column (clamped)", () => {
    const buffer = { ...TextBuffer.create("SELECT *\nFROM a.b\nWHERE x"), cursor: 3 }
    expect(TextBuffer.position(buffer)).toEqual({ line: 0, column: 3 })
    expect(TextBuffer.position(TextBuffer.move(buffer, CursorMove.down))).toEqual({ line: 1, column: 3 })
    expect(TextBuffer.position(TextBuffer.move(TextBuffer.move(buffer, CursorMove.lineEnd), CursorMove.down))).toEqual({ line: 1, column: 8 })
    expect(TextBuffer.move(buffer, CursorMove.up).cursor).toBe(0)
    expect(TextBuffer.move(buffer, CursorMove.documentEnd).cursor).toBe(buffer.text.length)
    expect(TextBuffer.move(TextBuffer.move(buffer, CursorMove.documentEnd), CursorMove.down).cursor).toBe(buffer.text.length)
    expect(TextBuffer.move(buffer, CursorMove.documentStart).cursor).toBe(0)
    expect(TextBuffer.move({ ...buffer, cursor: 12 }, CursorMove.lineStart).cursor).toBe(9)
    expect(TextBuffer.lines(buffer)).toHaveLength(3)
    expect(TextBuffer.offsetOf(buffer.text, { line: 9, column: 99 })).toBe(buffer.text.length)
  })

  it("is a no-op at the edges and keeps a bounded undo history", () => {
    const empty = TextBuffer.create()
    expect(TextBuffer.backspace(empty)).toBe(empty)
    expect(TextBuffer.deleteForward(empty)).toBe(empty)
    expect(TextBuffer.undo(empty)).toBe(empty)
    expect(TextBuffer.insert(empty, "")).toBe(empty)
    expect(TextBuffer.move(empty, CursorMove.left)).toBe(empty)
    expect(TextBuffer.replace(empty, "")).toBe(empty)
    const many = Array.from({ length: TextBuffer.MaxUndo + 10 }).reduce<ReturnType<typeof TextBuffer.create>>(
      buffer => TextBuffer.insert(buffer, "x"),
      empty
    )
    expect(many.undo).toHaveLength(TextBuffer.MaxUndo)
  })

  it("applies Ink keypresses: text, Return (multi-line only), deletion, arrows, Home/End, Ctrl+Z", () => {
    const apply = (buffer: ReturnType<typeof TextBuffer.create>, input: string, flags = {}, multiline = true) =>
      TextBuffer.applyKey(buffer, input, key(flags), multiline)
    let buffer = apply(TextBuffer.create(), "ab")
    buffer = apply(buffer, "", { return: true })
    expect(buffer.text).toBe("ab\n")
    expect(apply(buffer, "", { return: true }, false)).toBe(buffer)
    expect(apply(buffer, "", { backspace: true }).text).toBe("ab")
    expect(apply(buffer, "", { delete: true }).text).toBe("ab")
    expect(apply(buffer, "", { leftArrow: true }).cursor).toBe(2)
    expect(apply(apply(buffer, "", { upArrow: true }), "", { rightArrow: true }).cursor).toBe(1)
    expect(apply(buffer, "", { downArrow: true }).cursor).toBe(3)
    expect(apply(apply(buffer, "", { upArrow: true }), "", { end: true }).cursor).toBe(2)
    expect(apply(buffer, "", { home: true }).cursor).toBe(3)
    expect(apply(buffer, "z", { ctrl: true }).text).toBe("ab")
    expect(apply(buffer, "x", { meta: true })).toBe(buffer)
    expect(apply(buffer, "", { escape: true })).toBe(buffer)
  })
})
