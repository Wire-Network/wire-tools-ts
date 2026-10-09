import { range } from "lodash"

import { CellFormatter } from "../values/index.js"
import type { ResultView } from "./ResultView.js"

/** One find-in-results hit. */
export interface ResultSearchHit {
  /** View row index. */
  rowIndex: number
  /** Column name. */
  column: string
}

/** Find-in-results: case-insensitive match over display-formatted cells. */
export namespace ResultSearch {
  /**
   * Every (row, column) whose display text contains `text`, in view order.
   *
   * @param view - The view (projected columns only).
   * @param text - Search text; empty → no hits.
   * @returns Hits row-major.
   */
  export function find(view: ResultView, text: string): ResultSearchHit[] {
    if (text.length === 0) return []
    return range(view.rowCount).flatMap(rowIndex => {
      const row = view.row(rowIndex)
      return view.columns
        .filter(column => CellFormatter.containsText(column, row[column.name], text))
        .map(column => ({ rowIndex, column: column.name }))
    })
  }
}
