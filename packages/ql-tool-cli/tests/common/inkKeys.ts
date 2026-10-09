import type { Key } from "ink"

/** Every boolean Ink `Key` flag — the ONE list (the ink mock in tests/jest.setup.ts fills presses from it too). */
export const InkKeyFlags: readonly string[] = [
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageDown",
  "pageUp",
  "home",
  "end",
  "return",
  "escape",
  "ctrl",
  "shift",
  "tab",
  "backspace",
  "delete",
  "meta",
  "super",
  "hyper",
  "capsLock",
  "numLock"
] as const

/**
 * Every {@link InkKeyFlags} flag, true only where `flags` sets it.
 *
 * @param flags - Flags to set.
 * @returns The full flag record.
 */
export function keyFlags(flags: Readonly<Record<string, boolean>> = {}): Record<string, boolean> {
  return Object.fromEntries(InkKeyFlags.map(flag => [flag, flags[flag] === true]))
}

/**
 * An Ink `Key` with the given flags set.
 *
 * @param flags - Flags to set.
 * @returns The key.
 */
export function key(flags: Partial<Key> = {}): Key {
  return { ...(keyFlags() as unknown as Key), ...flags }
}
