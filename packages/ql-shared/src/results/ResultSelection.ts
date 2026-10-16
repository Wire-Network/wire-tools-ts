import { DelimitedText } from "./DelimitedText.js"
import { ResultView, type RowRange } from "./ResultView.js"

/** Copy format. */
export enum SelectionFormat {
  tsv = "tsv",
  json = "json"
}

/** Copy cell / row / column / range as TSV ({@link DelimitedText.TsvDialect}) or JSON (TUI yank and GUI copy). */
export namespace ResultSelection {
  /**
   * One cell.
   *
   * @param view - The view.
   * @param rowIndex - View row index.
   * @param column - Column name.
   * @param format - TSV or JSON.
   * @returns The copied text.
   */
  export function cell(view: ResultView, rowIndex: number, column: string, format: SelectionFormat): string {
    const target = ResultView.assertColumn(view.columns, column),
      value = view.row(rowIndex)[column]
    return format === SelectionFormat.json ? JSON.stringify(value) : DelimitedText.field(target, value, DelimitedText.TsvDialect)
  }

  /**
   * One row (projected columns).
   *
   * @param view - The view.
   * @param rowIndex - View row index.
   * @param format - TSV or JSON.
   * @returns The copied text.
   */
  export function row(view: ResultView, rowIndex: number, format: SelectionFormat): string {
    const values = view.row(rowIndex)
    return format === SelectionFormat.json
      ? JSON.stringify(view.projectRow(values))
      : DelimitedText.record(view.columns, values, DelimitedText.TsvDialect)
  }

  /**
   * One column (all view rows).
   *
   * @param view - The view.
   * @param column - Column name.
   * @param format - TSV (one value per line) or JSON (array).
   * @returns The copied text.
   */
  export function column(view: ResultView, column: string, format: SelectionFormat): string {
    const target = ResultView.assertColumn(view.columns, column),
      values = view.rows(view.fullRange()).map(values => values[column])
    return format === SelectionFormat.json
      ? JSON.stringify(values)
      : values.map(value => DelimitedText.field(target, value, DelimitedText.TsvDialect)).join(DelimitedText.RecordSeparator)
  }

  /**
   * A row range over the projected columns (TSV carries a header line).
   *
   * @param view - The view.
   * @param rowRange - Half-open row range.
   * @param format - TSV or JSON (array of objects).
   * @returns The copied text.
   */
  export function range(view: ResultView, rowRange: RowRange, format: SelectionFormat): string {
    const rows = view.rows(rowRange)
    return format === SelectionFormat.json
      ? JSON.stringify(rows.map(values => view.projectRow(values)))
      : [
          DelimitedText.header(view.columns, DelimitedText.TsvDialect),
          ...rows.map(values => DelimitedText.record(view.columns, values, DelimitedText.TsvDialect))
        ].join(DelimitedText.RecordSeparator)
  }
}
