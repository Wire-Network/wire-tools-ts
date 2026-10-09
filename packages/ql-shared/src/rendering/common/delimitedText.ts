import { DelimitedText, type DelimitedDialect } from "../../results/index.js"
import type { RenderConfig, RenderInput } from "../RenderOptions.js"
import { textLines } from "./textLines.js"

/** Shared CSV / TSV renderer body over {@link DelimitedText}. */
export namespace delimitedText {
  /**
   * Render rows as delimited text.
   *
   * @param input - What to render.
   * @param config - Header on/off.
   * @param dialect - Separator, null text and escaping.
   * @returns The text (records end with a newline).
   */
  export function render(input: RenderInput, config: RenderConfig, dialect: DelimitedDialect): string {
    const { columns } = input.view,
      header = config.header ? [DelimitedText.header(columns, dialect)] : [],
      records = input.view.rows(input.range).map(row => DelimitedText.record(columns, row, dialect))
    return textLines.render([...header, ...records])
  }
}
