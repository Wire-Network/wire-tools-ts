import { escape } from "lodash"

import type { QueryColumn } from "../../protocol/index.js"
import { CellAlignment, CellFormatter, type CellValue } from "../../values/index.js"
import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { resultSummary } from "../common/resultSummary.js"
import { textLines } from "../common/textLines.js"

/** Markdown file extension (the format name is `markdown`). */
const MarkdownExtension = "md"
/** Markup of a NULL cell — raw HTML, which cell text can never produce (its `<` is escaped). */
const NullCell = "<i>NULL</i>"
/** Markup of a line break inside a cell. */
const LineBreak = "<br>"
/** Line breaks inside a cell (CRLF first, so it becomes ONE break). */
const LineBreakPattern = /\r\n|\n|\r/g
/** Table-significant characters escaped with a backslash (backslash first). */
const BackslashEscapes = ["\\", "|"] as const
/** Header-rule cell of a left-aligned column. */
const LeftRule = "---"
/** Header-rule cell of a right-aligned column. */
const RightRule = "---:"

/**
 * Escape cell / header text: HTML-significant characters become entities
 * (lodash `escape`: `&` `<` `>` `"` `'`, so no cell text can form a tag), backslashes and pipes are
 * backslash-escaped, and line breaks become {@link LineBreak}.
 */
function escapeMarkdown(text: string): string {
  return BackslashEscapes.reduce((escaped, character) => escaped.replaceAll(character, `\\${character}`), escape(text)).replace(
    LineBreakPattern,
    LineBreak
  )
}

/** One Markdown cell (NULL is {@link NullCell}, so it never reads as the text `NULL`). */
function markdownCell(column: QueryColumn, value: CellValue): string {
  return value === null ? NullCell : escapeMarkdown(CellFormatter.canonical(column, value))
}

/** One table line. */
function line(cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}

/**
 * GitHub-flavored Markdown table. A Markdown table cannot exist without its
 * header row, so the header is always emitted; numbers are right-aligned.
 *
 * Convention: every `<`, `>`, `&` and `"` of cell text is an HTML entity, so
 * the only raw HTML in the output is the renderer's own — `<br>` for a line
 * break inside a cell and `<i>NULL</i>` for a NULL cell (distinct from a text
 * cell reading `NULL`).
 */
export const MarkdownResultRenderer: ResultRendererBackend = {
  format: OutputFormat.markdown,
  fileExtension: MarkdownExtension,
  render(input: RenderInput, config: RenderConfig): string {
    const { columns } = input.view,
      header = line(columns.map(column => escapeMarkdown(column.name))),
      rule = line(columns.map(column => (CellFormatter.alignment(column) === CellAlignment.right ? RightRule : LeftRule))),
      rows = input.view.rows(input.range).map(row => line(columns.map(column => markdownCell(column, row[column.name])))),
      summary = resultSummary.lines(input, config)
    return textLines.render([header, rule, ...rows, ...(summary.length === 0 ? [] : ["", ...summary])])
  }
}
