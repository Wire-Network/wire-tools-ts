import { Either } from "@3fv/prelude-ts"
import type { Argv } from "yargs"

import {
  CellWidthMode,
  OutputFormat,
  PageSizeMode,
  QueryPager,
  ResultRenderer,
  SortDirection,
  type ColumnFilter,
  type ColumnSort,
  type PageWindow,
  type RenderOptions,
  type ResultViewOptions
} from "@wireio/ql-shared"

import { isStdoutTTY } from "../../logger.js"
import { isWindowMember } from "../../utils/index.js"
import { QLUsageError } from "../exit/index.js"

/** Where the requested server window came from. */
export enum OutputWindowSource {
  /** `--page` / `--page-size` / `--all` (or their defaults). */
  pager = "pager",
  /** Explicit `--offset` / `--limit`. */
  explicit = "explicit"
}

/** Parsed server-window flags (resolved into {@link OutputConfig.pager} / {@link OutputConfig.window}). */
export interface OutputWindowOptions {
  /** `--page-size`: rows per server page. */
  pageSize?: number
  /** `--page`: 1-based server page. */
  page?: number
  /** `--all`: one request without limit. */
  all?: boolean
  /** `--limit`: explicit request limit (conflicts with --page/--page-size/--all). */
  limit?: number
  /** `--offset`: explicit request offset. */
  offset?: number
}

/** Parsed destination flag (optional even when resolved: undefined = stdout). */
export interface OutputDestinationOptions {
  /** `--output-file`: destination file. */
  outputFile?: string
}

/** Parsed output flags — every member optional (undefined = not given). */
export interface OutputOptions extends OutputWindowOptions, OutputDestinationOptions {
  /** `--format`. */
  format?: OutputFormat
  /** `--columns`: projection, in display order. */
  columns?: string[]
  /** `--sort`: `col` | `col:asc` | `col:desc`, repeatable. */
  sort?: string[]
  /** `--filter`: `col=text`, repeatable. */
  filter?: string[]
  /** `--no-header` → false. */
  header?: boolean
  /** `--show-stats`. */
  showStats?: boolean
  /** `--show-state`. */
  showState?: boolean
  /** `--color`: ANSI colors in table output. */
  color?: boolean
  /** `--cell-width`. */
  cellWidth?: CellWidthMode
}

/** Resolved output configuration (everything decided). */
export interface OutputConfig
  extends Required<Omit<OutputOptions, keyof OutputWindowOptions | keyof OutputDestinationOptions>>,
    OutputDestinationOptions {
  /** The server pager (from --page/--page-size, or --all). */
  pager: QueryPager
  /** The server window actually requested: explicit --offset/--limit when given, else the pager's. */
  window: PageWindow
  /** Which flags decided {@link window}. */
  windowSource: OutputWindowSource
}

/**
 * Output defaults (the ONE place). `format` depends on `outputFile` and is resolved
 * in {@link resolveOutputArgs}.
 *
 * @returns The default options.
 */
export function createOutputDefaultOptions(): Partial<OutputOptions> {
  return {
    pageSize: QueryPager.DefaultPageSize,
    page: QueryPager.FirstPage,
    all: false,
    columns: [],
    sort: [],
    filter: [],
    header: true,
    showStats: false,
    showState: false,
    color: isStdoutTTY(),
    cellWidth: CellWidthMode.truncated
  }
}

/**
 * Register output flags — NO `default:` (yargs `.conflicts` treats a defaulted
 * key as always given; defaults resolve once in {@link resolveOutputArgs}).
 *
 * @param builder - The yargs builder.
 * @returns The builder.
 */
export function applyOutputArgs<T>(builder: Argv<T>) {
  return builder
    .option("format", {
      alias: "f",
      choices: Object.values(OutputFormat),
      describe: `output format (default: from the --output-file extension, else ${OutputFormat.table})`
    })
    .option("page-size", { type: "number", describe: `rows per server page (default ${QueryPager.DefaultPageSize})` })
    .option("page", {
      type: "number",
      describe: `1-based page; sent as offset=(page-1)*page-size, limit=page-size (default ${QueryPager.FirstPage})`
    })
    .option("all", {
      type: "boolean",
      describe: "one request without limit — one snapshot, capped by the node's query-max-result-rows"
    })
    .option("limit", { type: "number", describe: "request limit (explicit window; the engine takes min with any SQL LIMIT)" })
    .option("offset", { type: "number", describe: "request offset (explicit window)" })
    .option("columns", { type: "array", string: true, describe: "project these columns (this page)" })
    .option("sort", { type: "array", string: true, describe: "col[:asc|desc], repeatable — sorts the loaded page" })
    .option("filter", { type: "array", string: true, describe: "col=text, repeatable — filters the loaded page" })
    .option("header", { type: "boolean", describe: "--no-header omits the header row (default: on)" })
    .option("output-file", { alias: "o", type: "string", describe: "write to this file instead of stdout" })
    .option("show-stats", { type: "boolean", describe: "append engine stats and the page summary" })
    .option("show-state", { type: "boolean", describe: "append the block snapshot the page reflects" })
    .option("color", { type: "boolean", describe: "ANSI colors in table output (default: stdout is a TTY)" })
    .option("cell-width", {
      choices: Object.values(CellWidthMode),
      describe: `table cell width (default ${CellWidthMode.truncated})`
    })
    .conflicts("all", ["page", "page-size", "limit", "offset"])
    .conflicts("limit", ["page", "page-size"])
    .conflicts("offset", ["page", "page-size"])
    .check(OutputArgs.assertRawFormatUnviewed)
}

/** Output-argument validators and parsers. */
export namespace OutputArgs {
  /** Separator of `--sort col:desc`. */
  export const SortSeparator = ":"
  /** Separator of `--filter col=text`. */
  export const FilterSeparator = "="

  /**
   * `--format raw` prints the engine result (one server page) verbatim: paging
   * flags are allowed (they shape the request), but client-side view flags that
   * were GIVEN (--sort / --filter / --columns) are rejected.
   *
   * @param argv - The parsed flags.
   * @returns true when valid.
   * @throws Error naming the offending flags (yargs reports it as a usage error).
   */
  export function assertRawFormatUnviewed(argv: OutputOptions): boolean {
    const viewFlags = [
      ["--columns", argv.columns],
      ["--sort", argv.sort],
      ["--filter", argv.filter]
    ]
      .filter(([, value]) => value !== undefined)
      .map(([flag]) => flag)
    if (argv.format === OutputFormat.raw && viewFlags.length > 0) {
      throw new QLUsageError(
        `--format ${OutputFormat.raw} prints the engine result verbatim; ${viewFlags.join(", ")} cannot apply`
      )
    }
    return true
  }

  /**
   * Parse one `--sort` spec.
   *
   * @param spec - `col`, `col:asc` or `col:desc`.
   * @returns The column sort.
   */
  export function parseSort(spec: string): ColumnSort {
    const separator = spec.lastIndexOf(SortSeparator),
      suffix = separator < 0 ? "" : spec.slice(separator + 1).toLowerCase(),
      direction = Object.values(SortDirection).find(candidate => candidate === suffix)
    return direction == null
      ? { column: spec, direction: SortDirection.asc }
      : { column: spec.slice(0, separator), direction }
  }

  /**
   * Parse one `--filter` spec.
   *
   * @param spec - `col=text`.
   * @returns The column filter.
   * @throws QLUsageError when the spec has no `=`.
   */
  export function parseFilter(spec: string): ColumnFilter {
    const separator = spec.indexOf(FilterSeparator)
    if (separator <= 0) {
      throw new QLUsageError(`--filter expects col${FilterSeparator}text, got "${spec}"`)
    }
    return { column: spec.slice(0, separator), text: spec.slice(separator + 1) }
  }

  /**
   * The client-side view of a resolved configuration (applies to the loaded page).
   *
   * @param config - The resolved output configuration.
   * @returns View options for `ResultView.create`.
   */
  export function viewOptions(config: OutputConfig): ResultViewOptions {
    return {
      sorts: config.sort.map(parseSort),
      filters: config.filter.map(parseFilter),
      ...(config.columns.length > 0 && { columns: config.columns })
    }
  }

  /**
   * Render options of a resolved configuration.
   *
   * @param config - The resolved output configuration.
   * @returns Options for `ResultRenderer.render`.
   */
  export function renderOptions(config: OutputConfig): RenderOptions {
    return {
      header: config.header,
      showStats: config.showStats,
      showState: config.showState,
      color: config.color && config.outputFile == null,
      cellWidthMode: config.cellWidth
    }
  }
}

/** Assert a request window member follows the ONE window rule ({@link isWindowMember}). */
function assertWindowMember(flag: string, value: number): void {
  if (value != null && !isWindowMember(value)) {
    throw new QLUsageError(`${flag} must be a non-negative integer, got ${value}`)
  }
}

/**
 * Resolve parsed flags → {@link OutputConfig}: explicit flags → (format: the
 * --output-file extension) → defaults ({@link createOutputDefaultOptions}).
 *
 * @param options - The parsed output flags.
 * @returns The resolved configuration.
 * @throws QLUsageError for an unknown --output-file extension or an invalid page/window.
 */
export function resolveOutputArgs(options: OutputOptions): OutputConfig {
  const fallback = createOutputDefaultOptions(),
    {
      format,
      limit,
      offset,
      outputFile,
      pageSize = fallback.pageSize,
      page = fallback.page,
      all = fallback.all,
      columns = fallback.columns,
      sort = fallback.sort,
      filter = fallback.filter,
      header = fallback.header,
      showStats = fallback.showStats,
      showState = fallback.showState,
      color = fallback.color,
      cellWidth = fallback.cellWidth
    } = options,
    resolvedFormat =
      format ??
      (outputFile == null
        ? OutputFormat.table
        : Either.try(() => ResultRenderer.formatForFile(outputFile))
            .ifLeft(error => {
              throw new QLUsageError(`cannot infer the format of ${outputFile}; pass --format`, { cause: error })
            })
            .getOrThrow()),
    pager = Either.try(() => (all ? new QueryPager({ mode: PageSizeMode.all }) : new QueryPager({ pageSize, page })))
      .ifLeft(error => {
        throw new QLUsageError(`invalid page: ${error.message}`, { cause: error })
      })
      .getOrThrow()
  assertWindowMember("--limit", limit)
  assertWindowMember("--offset", offset)
  const windowSource = limit != null || offset != null ? OutputWindowSource.explicit : OutputWindowSource.pager,
    window: PageWindow = windowSource === OutputWindowSource.explicit ? { limit, offset: offset ?? 0 } : pager.window
  return {
    format: resolvedFormat,
    columns,
    sort,
    filter,
    header,
    showStats,
    showState,
    color,
    cellWidth,
    pager,
    window,
    windowSource,
    outputFile
  }
}
