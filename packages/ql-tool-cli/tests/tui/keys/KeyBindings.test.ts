import { KeyBindings, KeyName, KeyScope, TuiAction } from "@wireio/ql-tool-cli/tui/index.js"

import { key } from "../../common/inkKeys.js"

describe("KeyBindings", () => {
  it.each([
    [KeyScope.editor, "r", { ctrl: true }, TuiAction.run],
    [KeyScope.editor, "r", { meta: true }, TuiAction.retry],
    [KeyScope.grid, "r", { meta: true }, TuiAction.retry],
    [KeyScope.grid, "c", {}, TuiAction.columns],
    [KeyScope.grid, "", { escape: true }, TuiAction.cancel],
    [KeyScope.editor, "", { tab: true }, TuiAction.focusNext],
    [KeyScope.editor, "", { tab: true, shift: true }, TuiAction.focusPrevious],
    [KeyScope.grid, "j", { meta: true }, TuiAction.toggleJson],
    [KeyScope.grid, "v", { meta: true }, TuiAction.toggleRecordView],
    [KeyScope.editor, "e", { meta: true }, TuiAction.export],
    [KeyScope.editor, "f", { meta: true }, TuiAction.format],
    [KeyScope.editor, "h", { meta: true }, TuiAction.history],
    [KeyScope.editor, "o", { meta: true }, TuiAction.saved],
    [KeyScope.editor, "w", { meta: true }, TuiAction.saveQuery],
    [KeyScope.editor, "l", { meta: true }, TuiAction.window],
    [KeyScope.editor, "p", { meta: true }, TuiAction.profiles],
    [KeyScope.editor, "?", { meta: true }, TuiAction.help],
    [KeyScope.editor, "c", { ctrl: true }, TuiAction.quit],
    [KeyScope.grid, "s", {}, TuiAction.sortColumn],
    [KeyScope.grid, "F", {}, TuiAction.filterColumn],
    [KeyScope.grid, "/", {}, TuiAction.find],
    [KeyScope.grid, "i", {}, TuiAction.inspect],
    [KeyScope.grid, "y", {}, TuiAction.copy],
    [KeyScope.grid, "", { pageUp: true }, TuiAction.previousPage],
    [KeyScope.grid, "", { pageDown: true }, TuiAction.nextPage],
    [KeyScope.grid, "", { home: true }, TuiAction.firstPage],
    [KeyScope.grid, "", { end: true }, TuiAction.lastPage],
    [KeyScope.grid, "z", {}, TuiAction.cyclePageSize]
  ])("%s %j %j → %s", (scope, input, flags, action) => {
    expect(KeyBindings.resolve(scope, input, key(flags))).toBe(action)
  })

  it("keeps grid letters out of the editor and the schema (global) scope", () => {
    expect(KeyBindings.resolve(KeyScope.editor, "s", key())).toBe(TuiAction.none)
    expect(KeyBindings.resolve(KeyScope.editor, "c", key())).toBe(TuiAction.none)
    expect(KeyBindings.resolve(KeyScope.global, "c", key())).toBe(TuiAction.none)
    expect(KeyBindings.resolve(KeyScope.global, "/", key())).toBe(TuiAction.none)
    expect(KeyBindings.resolve(KeyScope.editor, "", key({ pageDown: true }))).toBe(TuiAction.none)
  })

  it("binds no F-keys and none of Ctrl+H/J/I/M/S/Q", () => {
    const banned = ["h", "j", "i", "m", "s", "q"]
    KeyBindings.Defaults.forEach(binding => {
      expect(binding.chord.ctrl && banned.includes(binding.chord.input)).toBe(false)
      expect(binding.chord.input).not.toMatch(/^f\d+$/)
    })
    banned.forEach(input => expect(KeyBindings.resolve(KeyScope.grid, input, key({ ctrl: true }))).toBe(TuiAction.none))
  })

  it("reads named keys before input and lower-cases letters", () => {
    expect(KeyBindings.chordOf("X", key({ ctrl: true }))).toEqual({ input: "x", ctrl: true, meta: false, shift: false, key: KeyName.none })
    expect(KeyBindings.chordOf("\r", key({ return: true })).key).toBe(KeyName.return)
    expect(KeyBindings.matches(KeyBindings.chordOf("s", key({ shift: true })), KeyBindings.chordOf("s", key()))).toBe(true)
  })

  it("binds every chord at most once per scope (no binding shadows another)", () => {
    const chords = KeyBindings.Defaults.map(binding => `${binding.scope}:${JSON.stringify(binding.chord)}`)
    expect(new Set(chords).size).toBe(chords.length)
    KeyBindings.Defaults.filter(binding => binding.scope !== KeyScope.global).forEach(binding =>
      expect(KeyBindings.Defaults.some(other => other.scope === KeyScope.global && KeyBindings.matches(other.chord, binding.chord))).toBe(false)
    )
  })

  it("describes every binding for the Help route", () => {
    KeyBindings.Defaults.forEach(binding => expect(binding.describe.length).toBeGreaterThan(0))
  })

  it("labels chords the way hints and the Help route spell them", () => {
    expect(KeyBindings.labelOf(TuiAction.run)).toBe("Ctrl+R")
    expect(KeyBindings.labelOf(TuiAction.retry)).toBe("Alt+R")
    expect(KeyBindings.labelOf(TuiAction.help)).toBe("Alt+?")
    expect(KeyBindings.labelOf(TuiAction.focusPrevious)).toBe("S-Tab")
    expect(KeyBindings.labelOf(TuiAction.cancel)).toBe("Esc")
    expect(KeyBindings.labelOf(TuiAction.previousPage)).toBe("PgUp")
    expect(KeyBindings.labelOf(TuiAction.find)).toBe("/")
    expect(KeyBindings.labelOf(TuiAction.sortColumn)).toBe("s")
    expect(KeyBindings.label(KeyBindings.UndoChord)).toBe("Ctrl+Z")
    expect(KeyBindings.label({ input: "", ctrl: false, meta: false, shift: false, key: KeyName.return })).toBe("Enter")
  })

  it("builds chords with the exported helpers (the binding table uses the same ones)", () => {
    expect(KeyBindings.letterChord("t", { ctrl: true })).toEqual({ input: "t", ctrl: true, meta: false, shift: false, key: KeyName.none })
    expect(KeyBindings.namedChord(KeyName.tab, { shift: true })).toEqual({ input: "", ctrl: false, meta: false, shift: true, key: KeyName.tab })
    expect(KeyBindings.Defaults.find(binding => binding.action === TuiAction.run).chord).toEqual(KeyBindings.letterChord("r", { ctrl: true }))
  })

  it("labels arrows, Space and named keys; hint() pairs a label with its text", () => {
    expect(KeyBindings.label(KeyBindings.letterChord("t", { ctrl: true }))).toBe("Ctrl+T")
    expect(KeyBindings.label(KeyBindings.letterChord(KeyBindings.SpaceInput))).toBe("Space")
    expect([KeyName.upArrow, KeyName.downArrow, KeyName.leftArrow, KeyName.rightArrow].map(KeyBindings.namedLabel)).toEqual(["↑", "↓", "←", "→"])
    expect(KeyBindings.namedLabel(KeyName.escape)).toBe("Esc")
    expect(KeyBindings.UpDownLabel).toBe("↑↓")
    expect(KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "export")).toBe("Enter export")
  })

  it("reports arrow presses as their named key, which no binding takes", () => {
    expect(KeyBindings.chordOf("", key({ upArrow: true })).key).toBe(KeyName.upArrow)
    expect(KeyBindings.resolve(KeyScope.grid, "", key({ rightArrow: true }))).toBe(TuiAction.none)
  })

  it("labelOf throws for an action nothing is bound to", () => {
    expect(() => KeyBindings.labelOf(TuiAction.none)).toThrow("no key is bound to none")
  })

  it("helpLine pads the label so descriptions align", () => {
    const run = KeyBindings.Defaults.find(binding => binding.action === TuiAction.run)
    expect(KeyBindings.helpLine(run)).toBe(`${"Ctrl+R".padEnd(KeyBindings.HelpLabelWidth)}run the query`)
    KeyBindings.Defaults.forEach(binding => expect(KeyBindings.helpLine(binding).indexOf(binding.describe)).toBe(KeyBindings.HelpLabelWidth))
  })
})
