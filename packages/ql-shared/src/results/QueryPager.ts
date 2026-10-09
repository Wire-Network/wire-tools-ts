import { defaults } from "lodash"

import { NestedError } from "@wireio/shared"

import type { QueryPage } from "../protocol/index.js"
import { PageSizeMode } from "./PageSizeMode.js"

/** A page request (all optional). */
export interface PageRequestOptions {
  /** Paged or all (default paged). */
  mode?: PageSizeMode
  /** Rows per server page (default {@link QueryPager.DefaultPageSize}). */
  pageSize?: number
  /** 1-based page (default 1). */
  page?: number
}

/** Resolved page request. */
export interface PageRequestConfig extends Required<PageRequestOptions> {}

/** The server-side window of one page — what QueryEngineClient sends as `limit` / `offset`; `limit` null = no limit. */
export interface PageWindow {
  /** Request `limit` (null: none). */
  limit: number
  /** Request `offset`. */
  offset: number
}

/**
 * Defaults for {@link PageRequestOptions}.
 *
 * @returns The default options.
 */
export function createPageRequestDefaultOptions(): Partial<PageRequestOptions> {
  return { mode: PageSizeMode.paged, pageSize: QueryPager.DefaultPageSize, page: QueryPager.FirstPage }
}

/**
 * Server-side paging: page N ↔ (offset, limit), plus page math over the
 * server's `result.page`. Immutable — every `with*` returns a new pager. Each
 * page is its own single-block snapshot.
 */
export class QueryPager {
  /** Resolved request. */
  readonly config: PageRequestConfig

  /**
   * @param options - Mode, page size and page.
   */
  constructor(options: PageRequestOptions = {}) {
    this.config = defaults({ ...options }, createPageRequestDefaultOptions()) as PageRequestConfig
    const { pageSize, page } = this.config
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new NestedError(`page size must be a positive integer: ${pageSize}`, { context: { pageSize } })
    }
    if (!Number.isInteger(page) || page < QueryPager.FirstPage) {
      throw new NestedError(`page must be an integer >= ${QueryPager.FirstPage}: ${page}`, { context: { page } })
    }
  }

  /** Paged or all. */
  get mode(): PageSizeMode {
    return this.config.mode
  }

  /** Rows per page. */
  get pageSize(): number {
    return this.config.pageSize
  }

  /** 1-based page. */
  get page(): number {
    return this.config.page
  }

  /** Request window for the current page; `all` → no limit, offset 0 (ONE request, one snapshot). */
  get window(): PageWindow {
    return this.config.mode === PageSizeMode.all
      ? { limit: null, offset: 0 }
      : { limit: this.config.pageSize, offset: (this.config.page - QueryPager.FirstPage) * this.config.pageSize }
  }

  /**
   * Same pager on another page.
   *
   * @param page - 1-based page.
   * @returns The new pager.
   */
  withPage(page: number): QueryPager {
    return new QueryPager({ ...this.config, page })
  }

  /**
   * Another page size (back to page 1 — the old page number has no meaning).
   *
   * @param pageSize - Rows per page.
   * @returns The new pager.
   */
  withPageSize(pageSize: number): QueryPager {
    return new QueryPager({ ...this.config, pageSize, page: QueryPager.FirstPage })
  }

  /**
   * Another mode (back to page 1).
   *
   * @param mode - Paged or all.
   * @returns The new pager.
   */
  withMode(mode: PageSizeMode): QueryPager {
    return new QueryPager({ ...this.config, mode, page: QueryPager.FirstPage })
  }

  /**
   * Page count from a response's `page.total_rows` (≥ 1).
   *
   * @param page - The response page descriptor.
   * @param pageSize - Rows per page.
   * @returns The page count.
   */
  static pageCount(page: QueryPage, pageSize: number): number {
    return Math.max(QueryPager.FirstPage, Math.ceil(Number(page.total_rows) / pageSize))
  }
}

/** Pager constants. */
export namespace QueryPager {
  /** Default rows per page. */
  export const DefaultPageSize = 100
  /** First page number. */
  export const FirstPage = 1
  /** GUI/TUI page-size choices (the CLI accepts any positive integer). */
  export const PageSizeChoices: readonly number[] = [25, 50, 100, 500, 1_000] as const
}
