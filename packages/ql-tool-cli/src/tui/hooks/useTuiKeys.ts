import { useInput, type Key } from "ink"

import { KeyBindings, type KeyScope, type TuiAction } from "../keys/index.js"

/** One keypress, resolved. */
export interface TuiKeyEvent {
  /** The bound action (`none` when unbound — then `input` / `key` carry the raw press). */
  action: TuiAction
  /** Ink `input`. */
  input: string
  /** Ink `Key`. */
  key: Key
}

/**
 * Resolve every Ink keypress in `scope` to a {@link TuiAction} and hand it to
 * `onKey` (raw input travels along for text entry and navigation).
 *
 * @param scope - The focused scope.
 * @param onKey - Receives each resolved press.
 * @param isActive - Whether this handler listens (inactive while a modal owns the keys).
 */
export function useTuiKeys(scope: KeyScope, onKey: (event: TuiKeyEvent) => void, isActive = true): void {
  useInput((input, key) => onKey({ action: KeyBindings.resolve(scope, input, key), input, key }), { isActive })
}
