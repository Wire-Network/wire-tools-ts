import type { QueryExecutionSuccess } from "../client/index.js"
import type { ResultView, RowRange } from "../results/index.js"
import type { OutputFormat } from "./OutputFormat.js"

/** Cell truncation in table output. */
export enum CellWidthMode {
  full = "full",
  truncated = "truncated"
}

/** Render options (all optional). */
export interface RenderOptions {
  /** Emit the header row (formats that have one). */
  header?: boolean
  /** Append engine stats + page summary. */
  showStats?: boolean
  /** Append the block snapshot the page reflects. */
  showState?: boolean
  /** ANSI colors (table only). */
  color?: boolean
  /** Truncate wide table cells. */
  cellWidthMode?: CellWidthMode
  /** Max table cell width (columns) when truncating. */
  maxCellWidth?: number
}

/** Resolved render options. */
export interface RenderConfig extends Required<RenderOptions> {}

/**
 * Input for one render (composes domain types). The execution's result is the
 * ONE source: `view` must be a view over `execution.result` (asserted by
 * `ResultRenderer.render`).
 */
export interface RenderInput {
  /** The successful execution (one server page) — page / stats / state come from its result. */
  execution: QueryExecutionSuccess
  /** Sorted / filtered / projected view over `execution.result` — rows come from it. */
  view: ResultView
  /** View rows to render. */
  range: RowRange
}

/** A format backend (implemented privately per format). */
export interface ResultRendererBackend {
  /** The format it renders. */
  readonly format: OutputFormat
  /** File extension (without dot). */
  readonly fileExtension: string
  /**
   * Render.
   *
   * @param input - What to render.
   * @param config - Resolved options.
   * @returns The text.
   */
  render(input: RenderInput, config: RenderConfig): string
}
