/**
 * Clamp an index into `[0, count)` (0 for an empty list).
 *
 * @param index - The index.
 * @param count - The list length.
 * @returns The clamped index.
 */
export function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, index), Math.max(0, count - 1))
}

/**
 * Move a list cursor by `delta`, clamped to the list — the ONE cursor rule of
 * every TUI list (routes, schema tree, grid, column chooser, JSON scroll).
 *
 * @param cursor - The current index.
 * @param delta - Rows to move (negative = up).
 * @param count - The list length.
 * @returns The new index.
 */
export function moveCursor(cursor: number, delta: number, count: number): number {
  return clampIndex(cursor + delta, count)
}
