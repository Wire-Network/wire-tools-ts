/**
 * Adjust a sliding-window's `sliceStart` to keep `cursorIdx` visible while
 * preserving the user's scroll position when possible. Behavior:
 *
 *   - cursor still inside [start, start+size)  → start unchanged.
 *   - cursor < start                           → start := cursor (cursor at top).
 *   - cursor >= start+size                     → start := cursor - size + 1 (cursor at bottom).
 *
 * Clamped to `[0, max(0, totalCount - visibleCount)]` so the window never
 * scrolls past the end. Pure / referentially transparent — extracted for
 * unit testing without a React renderer.
 *
 * @param prevSliceStart current top-of-window index
 * @param cursorIdx      where the cursor lives now
 * @param totalCount     length of the underlying list
 * @param visibleCount   size of the viewport (≥ 1)
 */
export function adjustStickyWindow(
  prevSliceStart: number,
  cursorIdx: number,
  totalCount: number,
  visibleCount: number
): number {
  if (totalCount === 0 || visibleCount <= 0) return 0
  const maxStart = Math.max(0, totalCount - visibleCount),
    cappedPrev = Math.max(0, Math.min(prevSliceStart, maxStart)),
    end = cappedPrev + visibleCount
  if (cursorIdx < cappedPrev) return Math.max(0, cursorIdx)
  if (cursorIdx >= end) {
    return Math.max(0, Math.min(cursorIdx - visibleCount + 1, maxStart))
  }
  return cappedPrev
}
