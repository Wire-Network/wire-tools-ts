import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { textLines } from "../common/textLines.js"

/** JSON Lines: one row object per line (a stream format — no stats/state lines). */
export const JsonlResultRenderer: ResultRendererBackend = {
  format: OutputFormat.jsonl,
  fileExtension: OutputFormat.jsonl,
  render(input: RenderInput, _config: RenderConfig): string {
    return textLines.render(input.view.rows(input.range).map(row => JSON.stringify(input.view.projectRow(row))))
  }
}
