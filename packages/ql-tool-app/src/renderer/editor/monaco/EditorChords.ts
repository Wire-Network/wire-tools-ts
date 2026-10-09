import type * as Monaco from "monaco-editor"
import { match, P } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import { ActionRegistry, type AppAction } from "../../../common/index.js"

/**
 * Monaco key chords parsed from the action registry's Electron accelerators —
 * the editor binds exactly the chords the application menu shows, from the
 * same strings (`CmdOrCtrl+Shift+Enter` → `CtrlCmd | Shift | Enter`).
 */
export namespace EditorChords {
  /** Reads one modifier bit off the Monaco API. */
  export type ModifierBit = (monaco: typeof Monaco) => number

  /** Electron accelerator modifiers → their Monaco `KeyMod` bit. */
  export const Modifiers: Readonly<Record<string, ModifierBit>> = {
    [ActionRegistry.CmdOrCtrlModifier]: monaco => monaco.KeyMod.CtrlCmd,
    Shift: monaco => monaco.KeyMod.Shift,
    Alt: monaco => monaco.KeyMod.Alt
  }
  /** Electron accelerator key names whose Monaco `KeyCode` name differs. */
  export const KeyNames: Readonly<Record<string, keyof typeof Monaco.KeyCode>> = {
    ".": "Period",
    ",": "Comma"
  }
  /** Monaco's `KeyCode` prefix of letter keys (`KeyF`). */
  export const LetterKeyPrefix = "Key"

  /**
   * The Monaco keybinding of an Electron accelerator.
   *
   * @param monaco - The Monaco API.
   * @param accelerator - e.g. `CmdOrCtrl+Shift+Enter`.
   * @returns The `KeyMod | KeyCode` keybinding.
   * @throws NestedError for a modifier or key Monaco has no code for.
   */
  export function chordOf(monaco: typeof Monaco, accelerator: string): number {
    const parts = accelerator.split(ActionRegistry.AcceleratorSeparator),
      key = parts.pop(),
      modifiers = parts.reduce((chord, modifier) => chord | modifierBitOf(modifier, accelerator)(monaco), 0),
      code = monaco.KeyCode[keyCodeName(key)]
    if (code == null) throw new NestedError(`no Monaco key code for accelerator key ${key}`, { context: { accelerator } })
    return modifiers | code
  }

  /**
   * Bind one chord per action (each action's registry accelerator) to `perform`.
   *
   * @param editor - The editor.
   * @param monaco - The Monaco API.
   * @param actions - The actions the editor handles itself.
   * @param perform - Runs the action.
   */
  export function register(
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
    actions: readonly AppAction[],
    perform: (action: AppAction) => void
  ): void {
    actions.forEach(action =>
      editor.addCommand(chordOf(monaco, ActionRegistry.describe(action).accelerator), () => perform(action))
    )
  }

  /**
   * The bit reader of an accelerator modifier.
   *
   * @param modifier - `CmdOrCtrl`, `Shift`, `Alt`.
   * @param accelerator - For the error.
   * @returns The reader.
   * @throws NestedError for a modifier the editor does not bind.
   */
  function modifierBitOf(modifier: string, accelerator: string): ModifierBit {
    const bit = Modifiers[modifier]
    if (bit == null) throw new NestedError(`no Monaco modifier for accelerator modifier ${modifier}`, { context: { accelerator } })
    return bit
  }

  /**
   * The Monaco `KeyCode` member name of an accelerator key.
   *
   * @param key - `Enter`, `F`, `.`, `F5`, …
   * @returns The member name.
   */
  function keyCodeName(key: string): keyof typeof Monaco.KeyCode {
    return match(key)
      .with(P.when(name => KeyNames[name] != null), name => KeyNames[name])
      .with(P.string.regex(/^[A-Z]$/), letter => `${LetterKeyPrefix}${letter}` as keyof typeof Monaco.KeyCode)
      .otherwise(name => name as keyof typeof Monaco.KeyCode)
  }
}
