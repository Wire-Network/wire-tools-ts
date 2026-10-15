import { DelimitedText } from "../../results/index.js"
import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { delimitedText } from "../common/delimitedText.js"

/** TSV with backslash escapes (NULL = `\N`), the same dialect as copied selections. */
export const TsvResultRenderer: ResultRendererBackend = {
  format: OutputFormat.tsv,
  fileExtension: OutputFormat.tsv,
  render(input: RenderInput, config: RenderConfig): string {
    return delimitedText.render(input, config, DelimitedText.TsvDialect)
  }
}
