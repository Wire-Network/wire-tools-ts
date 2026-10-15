import { escape } from "lodash"

import { CellFormatter } from "../../values/index.js"
import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { textLines } from "../common/textLines.js"

/** Markup lines of the document skeleton. */
namespace XmlMarkup {
  export const Declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
  export const ResultOpen = "<result>"
  export const ResultClose = "</result>"
  export const RowOpen = "  <row>"
  export const RowClose = "  </row>"
  export const ColumnIndent = "    "
}

/** `<result><row><column name="…">…</column></row></result>`; NULL is `<column name="…" null="true"/>`. */
export const XmlResultRenderer: ResultRendererBackend = {
  format: OutputFormat.xml,
  fileExtension: OutputFormat.xml,
  render(input: RenderInput, _config: RenderConfig): string {
    const rows = input.view.rows(input.range).flatMap(row => [
      XmlMarkup.RowOpen,
      ...input.view.columns.map(column => {
        const value = row[column.name],
          name = escape(column.name)
        return value === null
          ? `${XmlMarkup.ColumnIndent}<column name="${name}" null="true"/>`
          : `${XmlMarkup.ColumnIndent}<column name="${name}">${escape(CellFormatter.canonical(column, value))}</column>`
      }),
      XmlMarkup.RowClose
    ])
    return textLines.render([XmlMarkup.Declaration, XmlMarkup.ResultOpen, ...rows, XmlMarkup.ResultClose])
  }
}
