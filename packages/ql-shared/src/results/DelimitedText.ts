import type { QueryColumn, QueryRow } from "../protocol/index.js"
import { CellFormatter, type CellValue } from "../values/index.js"

/** How one delimited format writes fields. */
export interface DelimitedDialect {
  /** Field separator. */
  separator: string
  /** Text of a NULL cell. */
  nullText: string
  /** Escape / quote one field. */
  escape: (text: string) => string
}

/** Characters that force RFC 4180 quoting. */
const CsvQuoteTrigger = /[",\r\n]/
/** CSV quote. */
const CsvQuote = "\""
/** TSV escapes (backslash first). */
const TsvEscapes: ReadonlyArray<readonly [string, string]> = [
  ["\\", "\\\\"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\r", "\\r"]
] as const

/**
 * The delimited dialects (CSV, TSV) and the field / record / header writers —
 * the ONE delimited-text implementation behind the CSV / TSV renderers and
 * copied TSV selections. Canonical cell text throughout.
 */
export namespace DelimitedText {
  /** Record separator of every delimited format. */
  export const RecordSeparator = "\n"

  /** RFC 4180 CSV: comma-separated, double-quoted when needed (quotes doubled); NULL = empty field. */
  export const CsvDialect: DelimitedDialect = {
    separator: ",",
    nullText: "",
    escape: text =>
      CsvQuoteTrigger.test(text) ? `${CsvQuote}${text.replaceAll(CsvQuote, CsvQuote + CsvQuote)}${CsvQuote}` : text
  }

  /** TSV with backslash escapes (`\\`, `\t`, `\n`, `\r`); NULL = `\N`. */
  export const TsvDialect: DelimitedDialect = {
    separator: "\t",
    nullText: "\\N",
    escape: text => TsvEscapes.reduce((escaped, [raw, replacement]) => escaped.replaceAll(raw, replacement), text)
  }

  /**
   * One field: the dialect's NULL text, or the escaped canonical cell text.
   *
   * @param column - The column.
   * @param value - The cell.
   * @param dialect - The dialect.
   * @returns The field text.
   */
  export function field(column: QueryColumn, value: CellValue, dialect: DelimitedDialect): string {
    return value === null ? dialect.nullText : dialect.escape(CellFormatter.canonical(column, value))
  }

  /**
   * One record over `columns` (no record separator).
   *
   * @param columns - The columns, in output order.
   * @param row - The row.
   * @param dialect - The dialect.
   * @returns The record text.
   */
  export function record(columns: QueryColumn[], row: QueryRow, dialect: DelimitedDialect): string {
    return columns.map(column => field(column, row[column.name], dialect)).join(dialect.separator)
  }

  /**
   * The header record of `columns` (escaped names; no record separator).
   *
   * @param columns - The columns, in output order.
   * @param dialect - The dialect.
   * @returns The header text.
   */
  export function header(columns: QueryColumn[], dialect: DelimitedDialect): string {
    return columns.map(column => dialect.escape(column.name)).join(dialect.separator)
  }
}
