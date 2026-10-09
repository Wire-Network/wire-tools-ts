/** Column separator of every tab-separated listing (`history list`, `schema …`, the TUI list routes). */
export const ListingColumnSeparator = "\t"

/** A listing cell without a value (a failed run's rows, an undescribed type, a column without an ABI type). */
export const ListingEmptyCell = "-"

/** Runs of whitespace (line breaks included). */
export const WhitespacePattern = /\s+/g

/**
 * Query text on one line: every run of whitespace becomes one space.
 *
 * @param text - SQL text (may span lines).
 * @returns The single-line text.
 */
export function singleLine(text: string): string {
  return text.replace(WhitespacePattern, " ")
}

/**
 * One listing line: the cells joined by {@link ListingColumnSeparator}.
 *
 * @param cells - The cells, in column order.
 * @returns The line.
 */
export function listingLine(cells: readonly (string | number)[]): string {
  return cells.join(ListingColumnSeparator)
}
