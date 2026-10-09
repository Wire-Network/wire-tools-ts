import { defaults } from "lodash"
import { match } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import { OutputFormat } from "./OutputFormat.js"
import {
  CellWidthMode,
  type RenderConfig,
  type RenderInput,
  type RenderOptions,
  type ResultRendererBackend
} from "./RenderOptions.js"
import { CsvResultRenderer } from "./renderers/CsvResultRenderer.js"
import { HtmlResultRenderer } from "./renderers/HtmlResultRenderer.js"
import { JsonlResultRenderer } from "./renderers/JsonlResultRenderer.js"
import { JsonResultRenderer } from "./renderers/JsonResultRenderer.js"
import { MarkdownResultRenderer } from "./renderers/MarkdownResultRenderer.js"
import { RawResultRenderer } from "./renderers/RawResultRenderer.js"
import { TableResultRenderer } from "./renderers/TableResultRenderer.js"
import { TsvResultRenderer } from "./renderers/TsvResultRenderer.js"
import { XmlResultRenderer } from "./renderers/XmlResultRenderer.js"

/**
 * Defaults for {@link RenderOptions}.
 *
 * @returns The default options.
 */
export function createRenderDefaultOptions(): Partial<RenderOptions> {
  return {
    header: true,
    showStats: false,
    showState: false,
    color: false,
    cellWidthMode: CellWidthMode.truncated,
    maxCellWidth: ResultRenderer.DefaultMaxCellWidth
  }
}

/** Extension separator of a file name. */
const ExtensionSeparator = "."

/** ONE facade rendering results in any {@link OutputFormat}; per-format backends are private. */
export namespace ResultRenderer {
  /** Default max table cell width (columns) when truncating. */
  export const DefaultMaxCellWidth = 48

  /**
   * Render the rows of `input` in `format`.
   *
   * @param format - Output format.
   * @param input - Execution, view and row range.
   * @param options - Render options.
   * @returns The rendered text.
   * @throws NestedError when the view is not over the execution's result.
   */
  export function render(format: OutputFormat, input: RenderInput, options: RenderOptions = {}): string {
    assertInput(input)
    const config = defaults({ ...options }, createRenderDefaultOptions()) as RenderConfig
    return backendFor(format).render(input, config)
  }

  /**
   * Assert the input's single source: the execution's result IS the result
   * the view is over (renderers read page/stats/state from the execution and
   * rows from the view, so the two must be the same page).
   *
   * @param input - The render input.
   * @throws NestedError when they differ.
   */
  export function assertInput(input: RenderInput): void {
    if (input.view.result !== input.execution.result) {
      throw new NestedError("render input: the view is not over the execution's result", {
        context: { requestId: input.execution.requestId }
      })
    }
  }

  /**
   * Format for an output file name, by extension (the first format claiming it wins: `.json` → json).
   *
   * @param file - File name or path.
   * @returns The format.
   * @throws NestedError listing the supported extensions when unknown.
   */
  export function formatForFile(file: string): OutputFormat {
    const extension = file.includes(ExtensionSeparator) ? file.slice(file.lastIndexOf(ExtensionSeparator) + 1).toLowerCase() : "",
      found = Object.values(OutputFormat).find(format => fileExtension(format) === extension)
    if (found == null) {
      throw new NestedError(`no output format for "${file}"`, {
        context: { file, supportedExtensions: Object.values(OutputFormat).map(fileExtension) }
      })
    }
    return found
  }

  /**
   * File extension (without dot) of a format.
   *
   * @param format - Output format.
   * @returns The extension.
   */
  export function fileExtension(format: OutputFormat): string {
    return backendFor(format).fileExtension
  }

  /** The private backend of a format. */
  function backendFor(format: OutputFormat): ResultRendererBackend {
    return match(format)
      .with(OutputFormat.table, () => TableResultRenderer)
      .with(OutputFormat.json, () => JsonResultRenderer)
      .with(OutputFormat.jsonl, () => JsonlResultRenderer)
      .with(OutputFormat.csv, () => CsvResultRenderer)
      .with(OutputFormat.tsv, () => TsvResultRenderer)
      .with(OutputFormat.markdown, () => MarkdownResultRenderer)
      .with(OutputFormat.html, () => HtmlResultRenderer)
      .with(OutputFormat.xml, () => XmlResultRenderer)
      .with(OutputFormat.raw, () => RawResultRenderer)
      .exhaustive()
  }
}
