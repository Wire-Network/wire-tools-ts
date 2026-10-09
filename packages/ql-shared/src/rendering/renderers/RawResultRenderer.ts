import { SchemaCodec } from "@wireio/cluster-tool-shared"

import { OutputFormat } from "../OutputFormat.js"
import type { RenderConfig, RenderInput, ResultRendererBackend } from "../RenderOptions.js"
import { textLines } from "../common/textLines.js"

/** The engine `result` verbatim (the requested server page; client sort/filter/projection ignored). */
export const RawResultRenderer: ResultRendererBackend = {
  format: OutputFormat.raw,
  fileExtension: OutputFormat.json,
  render(input: RenderInput, _config: RenderConfig): string {
    return textLines.render([JSON.stringify(input.execution.result, null, SchemaCodec.SerializeIndent)])
  }
}
