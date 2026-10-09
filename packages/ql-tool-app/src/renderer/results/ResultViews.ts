import {
  QueryExecutionStatus,
  ResultView,
  type QueryResult,
  type ResultViewOptions
} from "@wireio/ql-shared"

import type { ResultTab } from "../store/index.js"

/** Builds the client-side {@link ResultView} of a result tab (sorts, filters, visible columns). */
export namespace ResultViews {
  /**
   * The view options of a tab over `result` — the ONE projection of a tab's
   * sorts, filters and hidden columns (the panel and the export both use it).
   *
   * @param tab - The result tab.
   * @param result - The result the view reads (the loaded page, or an export's unpaged result).
   * @returns The options.
   */
  export function optionsOf(tab: ResultTab, result: QueryResult): ResultViewOptions {
    return {
      sorts: tab.view.sorts,
      filters: tab.view.filters,
      columns: result.columns.map(column => column.name).filter(name => !tab.view.hiddenColumns.includes(name))
    }
  }

  /**
   * The view over a tab's loaded rows (null when the tab has no successful result).
   *
   * @param tab - The result tab.
   * @returns The view, or null.
   */
  export function of(tab: ResultTab): ResultView {
    const execution = tab?.execution
    if (execution?.status !== QueryExecutionStatus.success) return null
    return ResultView.create(execution.result, optionsOf(tab, execution.result))
  }
}
