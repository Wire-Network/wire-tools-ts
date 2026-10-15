import { useWindowSize } from "ink"

/** The terminal size and the workbench layout derived from it. */
export interface TerminalSize {
  /** Columns. */
  columns: number
  /** Rows. */
  rows: number
  /** Width of the schema tree panel. */
  schemaWidth: number
  /** Visible editor lines. */
  editorHeight: number
  /** Visible result rows. */
  resultsHeight: number
}

/** Layout derivation (pure). */
export namespace TerminalSize {
  /** Schema panel width as a fraction of the terminal. */
  export const SchemaWidthRatio = 0.25
  /** Minimum schema panel width. */
  export const MinimumSchemaWidth = 20
  /** Visible editor lines. */
  export const EditorLines = 6
  /** Rows taken by header, connection bar, borders, tab strip, grid header and status bar. */
  export const ChromeRows = 16
  /** Minimum visible result rows. */
  export const MinimumResultsRows = 3

  /**
   * Layout of a terminal.
   *
   * @param columns - Terminal columns.
   * @param rows - Terminal rows.
   * @returns The size and derived layout.
   */
  export function layout(columns: number, rows: number): TerminalSize {
    return {
      columns,
      rows,
      schemaWidth: Math.max(MinimumSchemaWidth, Math.floor(columns * SchemaWidthRatio)),
      editorHeight: EditorLines,
      resultsHeight: Math.max(MinimumResultsRows, rows - ChromeRows - EditorLines)
    }
  }
}

/**
 * The live terminal size (Ink re-renders on resize) and the workbench layout.
 *
 * @returns The size.
 */
export function useTerminalSize(): TerminalSize {
  const { columns, rows } = useWindowSize()
  return TerminalSize.layout(columns, rows)
}
