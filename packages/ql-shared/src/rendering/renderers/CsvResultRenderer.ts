import { DelimitedText } from "../../results/index.js"
import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { delimitedText } from "../common/delimitedText.js"

/** RFC 4180 CSV (NULL = empty field). */
export const CsvResultRenderer: ResultRendererBackend = {
  format: OutputFormat.csv,
  fileExtension: OutputFormat.csv,
  render(input: RenderInput, config: RenderConfig): string {
    return delimitedText.render(input, config, DelimitedText.CsvDialect)
  }
}
