import { SchemaCodec } from "@wireio/cluster-tool-shared"

import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { textLines } from "../common/textLines.js"

/**
 * JSON: an array of row objects; with stats/state, an object
 * `{ rows, page, stats?, state? }`.
 */
export const JsonResultRenderer: ResultRendererBackend = {
  format: OutputFormat.json,
  fileExtension: OutputFormat.json,
  render(input: RenderInput, config: RenderConfig): string {
    const rows = input.view.rows(input.range).map(row => input.view.projectRow(row)),
      { result } = input.execution,
      document =
        config.showStats || config.showState
          ? {
              rows,
              page: result.page,
              ...(config.showStats && { stats: result.stats }),
              ...(config.showState && { state: result.state })
            }
          : rows
    return textLines.render([JSON.stringify(document, null, SchemaCodec.SerializeIndent)])
  }
}
