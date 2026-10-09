import type { QueryExecutionSuccess } from "../client/index.js"
import type { QueryPage, QueryResult, QueryState, QueryStats } from "../protocol/index.js"
import { QueryPager } from "./QueryPager.js"

/**
 * The one-line result summary every surface shows (CLI page footer, TUI status
 * bar / stats / connection bar, GUI status bar): the separator and one formatter
 * per part, so the same fact reads the same everywhere.
 */
export namespace ResultSummary {
  /** Separator between summary parts. */
  export const Separator = " · "
  /** Separator of a row range (`rows 1–100`). */
  export const RowRangeSeparator = "–"
  /** Label of a node whose state is synced. */
  export const SyncedText = "synced"
  /** Label of a node whose state is NOT synced (upper case: it is a warning). */
  export const NotSyncedText = "NOT synced"
  /** Fraction digits of a wall time in milliseconds. */
  export const WallTimeFractionDigits = 1

  /**
   * Join summary parts with {@link Separator}.
   *
   * @param parts - The parts, in order.
   * @returns The line.
   */
  export function join(parts: readonly string[]): string {
    return parts.join(Separator)
  }

  /**
   * The 1-based page a response's window starts on.
   *
   * @param page - The response page descriptor.
   * @param pageSize - Rows per page; null = no limit (one page holds every row).
   * @returns The page number.
   */
  export function pageNumber(page: QueryPage, pageSize: number): number {
    return Math.floor(Number(page.offset) / effectivePageSize(page, pageSize)) + QueryPager.FirstPage
  }

  /**
   * The page count of a response (never below {@link pageNumber}, so an offset past
   * the end still reads `page N/N`).
   *
   * @param page - The response page descriptor.
   * @param pageSize - Rows per page; null = no limit.
   * @returns The page count.
   */
  export function pageCount(page: QueryPage, pageSize: number): number {
    return Math.max(QueryPager.pageCount(page, effectivePageSize(page, pageSize)), pageNumber(page, pageSize))
  }

  /**
   * `page N/M`.
   *
   * @param page - The response page descriptor.
   * @param pageSize - Rows per page; null = no limit.
   * @returns The part.
   */
  export function pagePart(page: QueryPage, pageSize: number): string {
    return `page ${pageNumber(page, pageSize)}/${pageCount(page, pageSize)}`
  }

  /**
   * `rows a–b of total` (`rows 0 of total` for an empty page).
   *
   * @param page - The response page descriptor.
   * @returns The part.
   */
  export function rowsPart(page: QueryPage): string {
    const offset = Number(page.offset),
      returned = Number(page.returned_rows)
    return returned === 0
      ? `rows 0 of ${page.total_rows}`
      : `rows ${offset + 1}${RowRangeSeparator}${offset + returned} of ${page.total_rows}`
  }

  /**
   * `total N`.
   *
   * @param page - The response page descriptor.
   * @returns The part.
   */
  export function totalPart(page: QueryPage): string {
    return `total ${page.total_rows}`
  }

  /**
   * `block N` — the snapshot the page reflects.
   *
   * @param state - The response state.
   * @returns The part.
   */
  export function blockPart(state: QueryState): string {
    return `block ${state.block_num}`
  }

  /**
   * `LIB N` — the last irreversible block when the page was read.
   *
   * @param state - The response state.
   * @returns The part.
   */
  export function irreversiblePart(state: QueryState): string {
    return `LIB ${state.last_irreversible_block_num}`
  }

  /**
   * `scanned N` — rows the engine scanned.
   *
   * @param stats - The response stats.
   * @returns The part.
   */
  export function scannedPart(stats: QueryStats): string {
    return `scanned ${stats.scanned_rows}`
  }

  /**
   * `matched N` — rows that passed the filter.
   *
   * @param stats - The response stats.
   * @returns The part.
   */
  export function matchedPart(stats: QueryStats): string {
    return `matched ${stats.matched_rows}`
  }

  /**
   * `N µs server` — engine time.
   *
   * @param stats - The response stats.
   * @returns The part.
   */
  export function serverTimePart(stats: QueryStats): string {
    return `${stats.elapsed_us} µs server`
  }

  /**
   * `N ms wall` — client time including transport and retries.
   *
   * @param wallTimeMs - Client wall time in milliseconds.
   * @returns The part.
   */
  export function wallTimePart(wallTimeMs: number): string {
    return `${wallTimeMs.toFixed(WallTimeFractionDigits)} ms wall`
  }

  /**
   * `N µs server · M ms wall`.
   *
   * @param execution - The successful execution.
   * @returns The part.
   */
  export function elapsedPart(execution: QueryExecutionSuccess): string {
    return join([serverTimePart(execution.result.stats), wallTimePart(execution.wallTimeMs)])
  }

  /**
   * {@link SyncedText} or {@link NotSyncedText}.
   *
   * @param state - The response state.
   * @returns The label.
   */
  export function syncedLabel(state: QueryState): string {
    return state.synced ? SyncedText : NotSyncedText
  }

  /**
   * The page label `page N/M · rows a–b of total · block N` (the rows part carries the total).
   *
   * @param result - The engine result (one page).
   * @param pageSize - Rows per page; null = no limit.
   * @returns The label.
   */
  export function describe(result: QueryResult, pageSize: number): string {
    return join([pagePart(result.page, pageSize), rowsPart(result.page), blockPart(result.state)])
  }
}

/** A page size of at least 1; no limit counts the whole result as one page. */
function effectivePageSize(page: QueryPage, pageSize: number): number {
  return Math.max(pageSize ?? Number(page.total_rows), 1)
}
