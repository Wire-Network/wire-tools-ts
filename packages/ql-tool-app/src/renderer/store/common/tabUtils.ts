/** Anything kept in a tab strip: the editor tabs and the result tabs. */
export interface IdentifiedTab {
  /** Unique tab id. */
  id: string
}

/**
 * The tab with `id`.
 *
 * @param tabs - The tab strip (a draft inside a reducer).
 * @param id - Tab id.
 * @returns The tab, or undefined when no tab has that id.
 */
export function findTab<T extends IdentifiedTab>(tabs: T[], id: string): T {
  return tabs.find(tab => tab.id === id)
}

/**
 * The tab to focus after closing the one at `index`: its successor, else the new last tab.
 *
 * @param tabs - The remaining tabs.
 * @param index - Where the closed tab was.
 * @returns The id, or undefined when no tab remains.
 */
export function nextActive<T extends IdentifiedTab>(tabs: T[], index: number): string {
  return tabs[Math.min(index, tabs.length - 1)]?.id
}
