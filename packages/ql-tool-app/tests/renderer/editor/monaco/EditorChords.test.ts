import type * as Monaco from "monaco-editor"

import { ActionRegistry, AppAction } from "@wireio/ql-tool-app/common"
import { EditorChords, MonacoOptions } from "@wireio/ql-tool-app/renderer/editor/monaco"
import { PlatformFonts } from "@wireio/ql-tool-app/renderer/theme"

import * as monacoMock from "../../../__mocks__/monaco-editor.js"

/** The mock as the Monaco API type. */
const monaco = monacoMock as unknown as typeof Monaco

describe("EditorChords.chordOf", () => {
  it("parses the registry accelerators into Monaco keybindings", () => {
    expect(EditorChords.chordOf(monaco, ActionRegistry.describe(AppAction.run).accelerator)).toBe(
      monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.Enter
    )
    expect(EditorChords.chordOf(monaco, ActionRegistry.describe(AppAction.runSelection).accelerator)).toBe(
      monacoMock.KeyMod.CtrlCmd | monacoMock.KeyMod.Shift | monacoMock.KeyCode.Enter
    )
    expect(EditorChords.chordOf(monaco, ActionRegistry.describe(AppAction.formatQuery).accelerator)).toBe(
      monacoMock.KeyMod.Shift | monacoMock.KeyMod.Alt | monacoMock.KeyCode.KeyF
    )
  })

  it("rejects a key Monaco has no code for", () => {
    expect(() => EditorChords.chordOf(monaco, "CmdOrCtrl+Nope")).toThrow(/no Monaco key code for accelerator key Nope/)
    expect(() => EditorChords.chordOf(monaco, "Super+Enter")).toThrow(/no Monaco modifier for accelerator modifier Super/)
  })
})

describe("EditorChords.register", () => {
  it("binds one command per action, each performing its action", () => {
    const commands: Array<[number, () => void]> = [],
      editor = { addCommand: (chord: number, handler: () => void) => commands.push([chord, handler]) } as unknown as Monaco.editor.IStandaloneCodeEditor,
      perform = jest.fn()
    EditorChords.register(editor, monaco, [AppAction.run, AppAction.formatQuery], perform)
    expect(commands.map(([chord]) => chord)).toEqual([
      monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.Enter,
      monacoMock.KeyMod.Shift | monacoMock.KeyMod.Alt | monacoMock.KeyCode.KeyF
    ])
    commands[1][1]()
    expect(perform).toHaveBeenCalledWith(AppAction.formatQuery)
  })
})

describe("MonacoOptions.base", () => {
  it("is the shared desktop editor setup", () => {
    expect(MonacoOptions.base).toEqual({
      minimap: { enabled: false },
      fontFamily: PlatformFonts.Monospace,
      fontSize: PlatformFonts.BaseSizePx,
      automaticLayout: true,
      scrollBeyondLastLine: false
    })
  })
})
