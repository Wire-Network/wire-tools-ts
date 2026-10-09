import { escape } from "lodash"

import { CellFormatter, type CellValue } from "../../values/index.js"
import type { QueryColumn } from "../../protocol/index.js"
import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { textLines } from "../common/textLines.js"

/** Markup lines of the table skeleton. */
namespace HtmlMarkup {
  export const TableOpen = "<table>"
  export const TableClose = "</table>"
  export const HeadOpen = "  <thead>"
  export const HeadClose = "  </thead>"
  export const BodyOpen = "  <tbody>"
  export const BodyClose = "  </tbody>"
  export const RowIndent = "    "
  export const NullCell = "<td class=\"null\"></td>"
}

/** One `<td>` (NULL is an empty `<td class="null">`). */
function dataCell(column: QueryColumn, value: CellValue): string {
  return value === null ? HtmlMarkup.NullCell : `<td>${escape(CellFormatter.canonical(column, value))}</td>`
}

/** `<table>` with `<thead>` (when headers are on) and entity-escaped text; NULL cells are empty `<td class="null">`. */
export const HtmlResultRenderer: ResultRendererBackend = {
  format: OutputFormat.html,
  fileExtension: OutputFormat.html,
  render(input: RenderInput, config: RenderConfig): string {
    const { columns } = input.view,
      head = config.header
        ? [
            HtmlMarkup.HeadOpen,
            `${HtmlMarkup.RowIndent}<tr>${columns.map(column => `<th>${escape(column.name)}</th>`).join("")}</tr>`,
            HtmlMarkup.HeadClose
          ]
        : [],
      body = input.view
        .rows(input.range)
        .map(row => `${HtmlMarkup.RowIndent}<tr>${columns.map(column => dataCell(column, row[column.name])).join("")}</tr>`)
    return textLines.render([HtmlMarkup.TableOpen, ...head, HtmlMarkup.BodyOpen, ...body, HtmlMarkup.BodyClose, HtmlMarkup.TableClose])
  }
}
