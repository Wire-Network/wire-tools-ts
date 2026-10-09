import { wcswidth, wcwidth } from "simple-wcswidth"

/**
 * Terminal column width of display text, via simple-wcswidth (Markus Kuhn's wcwidth tables).
 *
 * Limitations (documented, pinned by DisplayWidth.test.ts): code points are
 * measured one at a time — emoji ZWJ sequences, skin-tone modifiers and other
 * multi-code-point graphemes are summed per code point rather than treated as
 * one cluster, and emoji presentation is not special-cased. `wcswidth` returns
 * -1 for strings containing a control character; table cells never reach it
 * with one because {@link CellFormatter} renders control characters as visible
 * escapes (`\n` → `␊`, `\t` → `␉`) in DISPLAY mode first. As a defensive
 * fallback a -1 result is recomputed by summing `max(0, wcwidth(codePoint))`.
 */
export namespace DisplayWidth {
  /**
   * Columns occupied by `text` when printed in a terminal / monospace grid.
   *
   * @param text - Display text.
   * @returns Column count.
   */
  export function of(text: string): number {
    const width = wcswidth(text)
    return width >= 0 ? width : sumCodePoints(text)
  }

  /** Per-code-point fallback (control characters count 0). */
  function sumCodePoints(text: string): number {
    return Array.from(text).reduce(
      (sum, character) => sum + Math.max(0, wcwidth(character.codePointAt(0))),
      0
    )
  }
}
