import type { Key } from "ink"
import { match, P } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import { TextBuffer } from "../editor/index.js"
import { TuiAction } from "./TuiAction.js"

/** Focus scope a binding applies in (`global` bindings apply everywhere). */
export enum KeyScope {
  global = "global",
  editor = "editor",
  grid = "grid"
}

/** Named non-printable keys (mirrors Ink `Key` booleans). */
export enum KeyName {
  none = "none",
  escape = "escape",
  tab = "tab",
  pageUp = "pageUp",
  pageDown = "pageDown",
  home = "home",
  end = "end",
  return = "return",
  upArrow = "upArrow",
  downArrow = "downArrow",
  leftArrow = "leftArrow",
  rightArrow = "rightArrow"
}

/** A chord as Ink reports it (`useInput(input, key)`). */
export interface KeyChord {
  /** Printable input (lower-cased letters; empty for named keys). */
  input: string
  /** Ctrl held. */
  ctrl: boolean
  /** Alt / Meta held. */
  meta: boolean
  /** Shift held (only significant for named keys: Shift+Tab). */
  shift: boolean
  /** The named key, or `none`. */
  key: KeyName
}

/** One binding row. */
export interface KeyBinding {
  /** What it does. */
  action: TuiAction
  /** Where it applies. */
  scope: KeyScope
  /** The chord. */
  chord: KeyChord
  /** What it does (the Help route prints it after {@link KeyBindings.label}). */
  describe: string
}

/** Ink `Key` flag → {@link KeyName}, in priority order. */
const NamedKeyFlags: ReadonlyArray<readonly [keyof Key, KeyName]> = [
  ["escape", KeyName.escape],
  ["tab", KeyName.tab],
  ["pageUp", KeyName.pageUp],
  ["pageDown", KeyName.pageDown],
  ["home", KeyName.home],
  ["end", KeyName.end],
  ["return", KeyName.return],
  ["upArrow", KeyName.upArrow],
  ["downArrow", KeyName.downArrow],
  ["leftArrow", KeyName.leftArrow],
  ["rightArrow", KeyName.rightArrow]
] as const

/**
 * The key binding table and its resolver. No F-keys (Ink reports none) and no
 * Ctrl+H/J/I/M (= Backspace/LF/Tab/CR) or Ctrl+S/Q (XOFF/XON) chords.
 */
export namespace KeyBindings {
  /**
   * The chord of a printable key — every binding, dialog key and hint builds its
   * printable chords here.
   *
   * @param input - The printable input (lower-case letter, punctuation, or a space).
   * @param modifiers - Ctrl / Alt / Shift.
   * @returns The chord.
   */
  export function letterChord(input: string, modifiers: Partial<KeyChord> = {}): KeyChord {
    return { input, ctrl: false, meta: false, shift: false, key: KeyName.none, ...modifiers }
  }

  /**
   * The chord of a named (non-printable) key.
   *
   * @param key - The named key.
   * @param modifiers - Ctrl / Alt / Shift.
   * @returns The chord.
   */
  export function namedChord(key: KeyName, modifiers: Partial<KeyChord> = {}): KeyChord {
    return { input: "", ctrl: false, meta: false, shift: false, key, ...modifiers }
  }

  /**
   * global: Ctrl+R run · Alt+R retry (a retryable failure) · Esc cancel · Tab/Shift+Tab focus · Alt+J JSON ·
   * Alt+V record view · Alt+E export · Alt+F format SQL · Alt+H history · Alt+O saved · Alt+W save query ·
   * Alt+L offset/limit window · Alt+P profiles · Alt+? help · Ctrl+C quit.
   * grid (focus-scoped letters): s sort · f filter · c columns · / find · i inspect · y copy · PgUp/PgDn page ·
   * Home/End first/last page · z cycle page size. editor: plain text; Ctrl+R still runs.
   */
  export const Defaults: readonly KeyBinding[] = [
    { action: TuiAction.run, scope: KeyScope.global, chord: letterChord("r", { ctrl: true }), describe: "run the query" },
    {
      action: TuiAction.retry,
      scope: KeyScope.global,
      chord: letterChord("r", { meta: true }),
      describe: "retry the failed query (when retryable)"
    },
    { action: TuiAction.cancel, scope: KeyScope.global, chord: namedChord(KeyName.escape), describe: "cancel the running query / close" },
    { action: TuiAction.focusNext, scope: KeyScope.global, chord: namedChord(KeyName.tab), describe: "next panel" },
    {
      action: TuiAction.focusPrevious,
      scope: KeyScope.global,
      chord: namedChord(KeyName.tab, { shift: true }),
      describe: "previous panel"
    },
    { action: TuiAction.toggleJson, scope: KeyScope.global, chord: letterChord("j", { meta: true }), describe: "grid / JSON" },
    { action: TuiAction.toggleRecordView, scope: KeyScope.global, chord: letterChord("v", { meta: true }), describe: "record view" },
    { action: TuiAction.export, scope: KeyScope.global, chord: letterChord("e", { meta: true }), describe: "export" },
    { action: TuiAction.format, scope: KeyScope.global, chord: letterChord("f", { meta: true }), describe: "format the SQL" },
    { action: TuiAction.history, scope: KeyScope.global, chord: letterChord("h", { meta: true }), describe: "history" },
    { action: TuiAction.saved, scope: KeyScope.global, chord: letterChord("o", { meta: true }), describe: "saved queries" },
    { action: TuiAction.saveQuery, scope: KeyScope.global, chord: letterChord("w", { meta: true }), describe: "save the query" },
    { action: TuiAction.window, scope: KeyScope.global, chord: letterChord("l", { meta: true }), describe: "offset / limit window" },
    { action: TuiAction.profiles, scope: KeyScope.global, chord: letterChord("p", { meta: true }), describe: "profiles" },
    { action: TuiAction.help, scope: KeyScope.global, chord: letterChord("?", { meta: true }), describe: "help" },
    { action: TuiAction.quit, scope: KeyScope.global, chord: letterChord("c", { ctrl: true }), describe: "quit" },
    { action: TuiAction.sortColumn, scope: KeyScope.grid, chord: letterChord("s"), describe: "sort by the column (this page)" },
    { action: TuiAction.filterColumn, scope: KeyScope.grid, chord: letterChord("f"), describe: "filter the column (this page)" },
    { action: TuiAction.columns, scope: KeyScope.grid, chord: letterChord("c"), describe: "show / hide columns (this page)" },
    { action: TuiAction.find, scope: KeyScope.grid, chord: letterChord("/"), describe: "find in results" },
    { action: TuiAction.inspect, scope: KeyScope.grid, chord: letterChord("i"), describe: "inspect the cell" },
    { action: TuiAction.copy, scope: KeyScope.grid, chord: letterChord("y"), describe: "copy the row (TSV)" },
    { action: TuiAction.previousPage, scope: KeyScope.grid, chord: namedChord(KeyName.pageUp), describe: "previous server page" },
    { action: TuiAction.nextPage, scope: KeyScope.grid, chord: namedChord(KeyName.pageDown), describe: "next server page" },
    { action: TuiAction.firstPage, scope: KeyScope.grid, chord: namedChord(KeyName.home), describe: "first page" },
    { action: TuiAction.lastPage, scope: KeyScope.grid, chord: namedChord(KeyName.end), describe: "last page" },
    { action: TuiAction.cyclePageSize, scope: KeyScope.grid, chord: letterChord("z"), describe: "cycle page size / All" }
  ] as const

  /** Label of each named key. */
  export const KeyNameLabels: Readonly<Record<KeyName, string>> = {
    [KeyName.none]: "",
    [KeyName.escape]: "Esc",
    [KeyName.tab]: "Tab",
    [KeyName.pageUp]: "PgUp",
    [KeyName.pageDown]: "PgDn",
    [KeyName.home]: "Home",
    [KeyName.end]: "End",
    [KeyName.return]: "Enter",
    [KeyName.upArrow]: "↑",
    [KeyName.downArrow]: "↓",
    [KeyName.leftArrow]: "←",
    [KeyName.rightArrow]: "→"
  }
  /** Printable input spelled as a word in a label (a bare space would be invisible). */
  export const SpaceInput = " "
  /** Label of each printable input that is not its own label. */
  export const InputLabels: Readonly<Record<string, string>> = { [SpaceInput]: "Space" }
  /** Label prefix of Ctrl. */
  export const CtrlLabel = "Ctrl+"
  /** Label prefix of Alt / Meta. */
  export const MetaLabel = "Alt+"
  /** Label prefix of Shift (named keys only: `S-Tab`). */
  export const ShiftLabel = "S-"
  /** Column the help text starts at on a Help-route line. */
  export const HelpLabelWidth = 8
  /** The editor's undo chord (handled by {@link TextBuffer.applyKey}, not a binding). */
  export const UndoChord: KeyChord = letterChord(TextBuffer.UndoInput, { ctrl: true })
  /** Label of the vertical cursor keys (`↑↓`) every list hint shows. */
  export const UpDownLabel = `${namedLabel(KeyName.upArrow)}${namedLabel(KeyName.downArrow)}`

  /**
   * A chord's label as every hint, title and the Help route spell it
   * (`Ctrl+R`, `Alt+J`, `S-Tab`, `PgUp`, `s`).
   *
   * @param chord - The chord.
   * @returns The label.
   */
  export function label(chord: KeyChord): string {
    const modified = chord.ctrl || chord.meta,
      key = match(chord)
        .with({ key: KeyName.none, input: P.when(input => input in InputLabels) }, ({ input }) => InputLabels[input])
        .with({ key: KeyName.none }, ({ input }) => (modified ? input.toUpperCase() : input))
        .otherwise(({ key: named }) => KeyNameLabels[named])
    return [
      chord.ctrl ? CtrlLabel : "",
      chord.meta ? MetaLabel : "",
      chord.shift && chord.key !== KeyName.none ? ShiftLabel : "",
      key
    ].join("")
  }

  /**
   * The label of a named key (`Enter`, `Esc`, `↑`).
   *
   * @param key - The named key.
   * @returns The label.
   */
  export function namedLabel(key: KeyName): string {
    return label(namedChord(key))
  }

  /**
   * One hint part: a chord's label, then what it does (`Ctrl+T page/all`).
   *
   * @param chord - The chord.
   * @param text - What it does.
   * @returns The hint part.
   */
  export function hint(chord: KeyChord, text: string): string {
    return `${label(chord)} ${text}`
  }

  /**
   * The label of the chord bound to `action` (its first binding).
   *
   * @param action - The action.
   * @returns The label.
   * @throws NestedError when nothing is bound to the action.
   */
  export function labelOf(action: TuiAction): string {
    const binding = Defaults.find(candidate => candidate.action === action)
    if (binding == null) throw new NestedError(`no key is bound to ${action}`, { context: { action } })
    return label(binding.chord)
  }

  /**
   * One Help-route line: the chord label padded to {@link HelpLabelWidth}, then the description.
   *
   * @param binding - The binding.
   * @returns The line.
   */
  export function helpLine(binding: KeyBinding): string {
    return `${label(binding.chord).padEnd(HelpLabelWidth)}${binding.describe}`
  }

  /**
   * The chord Ink reported.
   *
   * @param input - Ink `input`.
   * @param key - Ink `Key`.
   * @returns The chord.
   */
  export function chordOf(input: string, key: Key): KeyChord {
    const found = NamedKeyFlags.find(([flag]) => key[flag] === true)
    return {
      input: found == null ? input.toLowerCase() : "",
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
      key: found == null ? KeyName.none : found[1]
    }
  }

  /**
   * Whether a binding's chord matches a reported chord (Shift is significant
   * only for named keys).
   *
   * @param bound - The binding's chord.
   * @param pressed - The reported chord.
   * @returns Whether they match.
   */
  export function matches(bound: KeyChord, pressed: KeyChord): boolean {
    return (
      bound.key === pressed.key &&
      bound.input === pressed.input &&
      bound.ctrl === pressed.ctrl &&
      bound.meta === pressed.meta &&
      (bound.key === KeyName.none || bound.shift === pressed.shift)
    )
  }

  /**
   * Resolve an Ink (input, Key) pair in a scope → action (global bindings
   * apply in every scope; `none` when unbound).
   *
   * @param scope - The focused scope.
   * @param input - Ink `input`.
   * @param key - Ink `Key`.
   * @returns The action.
   */
  export function resolve(scope: KeyScope, input: string, key: Key): TuiAction {
    const pressed = chordOf(input, key)
    return (
      Defaults.find(
        binding => (binding.scope === KeyScope.global || binding.scope === scope) && matches(binding.chord, pressed)
      )?.action ?? TuiAction.none
    )
  }
}
