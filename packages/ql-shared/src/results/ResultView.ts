import { range } from "lodash"

import { NestedError } from "@wireio/shared"

import type { QueryColumn, QueryResult, QueryRow } from "../protocol/index.js"
import { CellFormatter, type CellSortKey } from "../values/index.js"
import { SortDirection } from "./SortDirection.js"

/** One column sort. */
export interface ColumnSort {
  /** Column name. */
  column: string
  /** Direction. */
  direction: SortDirection
}

/** One column filter (case-insensitive contains over display text). */
export interface ColumnFilter {
  /** Column name. */
  column: string
  /** Text the display value must contain. */
  text: string
}

/** View options: sorts, filters, projection (all optional). */
export interface ResultViewOptions {
  /** Sort keys, most significant first. */
  sorts?: ColumnSort[]
  /** Filters (all must match). */
  filters?: ColumnFilter[]
  /** Projected columns in display order (default: all). */
  columns?: string[]
}

/** Resolved view options. */
export interface ResultViewConfig extends Required<ResultViewOptions> {}

/** Half-open row index range `[start, end)`. */
export interface RowRange {
  /** First index. */
  start: number
  /** One past the last index. */
  end: number
}

/**
 * Sorted / filtered / projected view over the rows of ONE result page —
 * identical semantics in every surface. NULL sorts last in either direction
 * (the engine's ORDER BY rule); sorting is stable.
 */
export class ResultView {
  private constructor(
    /** The underlying result. */
    readonly result: QueryResult,
    /** Resolved options. */
    readonly config: ResultViewConfig,
    private readonly order: number[],
    private readonly projected: QueryColumn[]
  ) {}

  /**
   * Build a view; asserts every named column exists.
   *
   * @param result - The result page.
   * @param options - Sorts, filters, projection.
   * @returns The view.
   * @throws NestedError naming an unknown column.
   */
  static create(result: QueryResult, options: ResultViewOptions = {}): ResultView {
    const { sorts = [], filters = [], columns = result.columns.map(column => column.name) } = options,
      assertColumn = (name: string) => ResultView.assertColumn(result.columns, name),
      projected = columns.map(assertColumn),
      filterColumns = filters.map(filter => ({ column: assertColumn(filter.column), text: filter.text })),
      sortColumns = sorts.map(sort => ({ column: assertColumn(sort.column), direction: sort.direction })),
      kept = range(result.rows.length).filter(index =>
        filterColumns.every(({ column, text }) => CellFormatter.containsText(column, result.rows[index][column.name], text))
      ),
      // One key per (kept row, sort column), computed once — not per comparison.
      keys = new Map<number, CellSortKey[]>(
        kept.map(index => [index, sortColumns.map(({ column }) => CellFormatter.sortKey(column, result.rows[index][column.name]))])
      ),
      order = [...kept].sort((left, right) => {
        const leftKeys = keys.get(left),
          rightKeys = keys.get(right),
          decided = sortColumns
            .map(({ column, direction }, sortIndex) => {
              const leftKey = leftKeys[sortIndex],
                rightKey = rightKeys[sortIndex],
                compared = CellFormatter.compareSortKeys(column, leftKey, rightKey)
              return leftKey === null || rightKey === null || direction === SortDirection.asc ? compared : -compared
            })
            .find(compared => compared !== 0)
        return decided ?? left - right
      })
    return new ResultView(result, { sorts, filters, columns }, order, projected)
  }

  /** Projected columns in display order. */
  get columns(): QueryColumn[] {
    return this.projected
  }

  /** Rows after filtering. */
  get rowCount(): number {
    return this.order.length
  }

  /**
   * One row in view order.
   *
   * @param index - View index.
   * @returns The row (all cells; projection is by {@link columns}).
   */
  row(index: number): QueryRow {
    return this.result.rows[this.order[index]]
  }

  /**
   * Rows of a view range (clamped to the view).
   *
   * @param rowRange - Half-open range.
   * @returns The rows.
   */
  rows(rowRange: RowRange): QueryRow[] {
    return this.order
      .slice(Math.max(0, rowRange.start), Math.min(this.order.length, rowRange.end))
      .map(index => this.result.rows[index])
  }

  /**
   * The projected-column object of a row (raw engine cells, display order).
   *
   * @param row - A row of this view.
   * @returns A new object holding only the projected columns.
   */
  projectRow(row: QueryRow): QueryRow {
    return Object.fromEntries(this.projected.map(column => [column.name, row[column.name]]))
  }

  /**
   * The whole view as a range.
   *
   * @returns `[0, rowCount)`.
   */
  fullRange(): RowRange {
    return { start: 0, end: this.rowCount }
  }
}

/** View helpers. */
export namespace ResultView {
  /**
   * The column named `name` among `columns`.
   *
   * @param columns - The columns to search (a result's, or a view's projection).
   * @param name - Column name.
   * @returns The column.
   * @throws NestedError naming the unknown column and the known ones.
   */
  export function assertColumn(columns: QueryColumn[], name: string): QueryColumn {
    const found = columns.find(candidate => candidate.name === name)
    if (found == null) {
      throw new NestedError(`unknown column ${name}`, {
        context: { column: name, columns: columns.map(column => column.name) }
      })
    }
    return found
  }
}
