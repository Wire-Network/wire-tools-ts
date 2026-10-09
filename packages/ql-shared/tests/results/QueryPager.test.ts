import { createPageRequestDefaultOptions, PageSizeMode, QueryPager } from "@wireio/ql-shared"

import { createResult, SampleColumns } from "../common/resultFixtures.js"

/** The page descriptor of an empty page over `total` rows. */
const page = (total: number) => createResult(SampleColumns, [], total).page

describe("QueryPager", () => {
  it("defaults to page 1 of 100 rows", () => {
    const pager = new QueryPager()
    expect(pager.window).toEqual({ limit: QueryPager.DefaultPageSize, offset: 0 })
    expect([pager.mode, pager.page, pager.pageSize]).toEqual([PageSizeMode.paged, 1, 100])
    expect(createPageRequestDefaultOptions()).toEqual({ mode: PageSizeMode.paged, pageSize: 100, page: 1 })
  })

  it("maps page N to offset (N-1)·size, limit size", () => {
    expect(new QueryPager({ pageSize: 25, page: 3 }).window).toEqual({ limit: 25, offset: 50 })
    expect(new QueryPager({ pageSize: 25 }).withPage(2).window).toEqual({ limit: 25, offset: 25 })
  })

  it("resets to page 1 when the size or mode changes", () => {
    expect(new QueryPager({ page: 4 }).withPageSize(10).page).toBe(1)
    expect(new QueryPager({ page: 4 }).withMode(PageSizeMode.all).page).toBe(1)
  })

  it("all mode is one request without a limit", () => {
    expect(new QueryPager({ mode: PageSizeMode.all, page: 1 }).window).toEqual({ limit: null, offset: 0 })
  })

  it("computes page counts from total_rows (at least 1)", () => {
    expect(QueryPager.pageCount(page(0), 25)).toBe(1)
    expect(QueryPager.pageCount(page(26), 25)).toBe(2)
    expect(QueryPager.pageCount(page(100), 25)).toBe(4)
  })

  it("rejects invalid sizes and pages", () => {
    expect(() => new QueryPager({ pageSize: 0 })).toThrow("page size")
    expect(() => new QueryPager({ page: 0 })).toThrow("page must be")
    expect(() => new QueryPager({ pageSize: 1.5 })).toThrow()
  })

  it("offers the GUI/TUI page-size choices", () => {
    expect(QueryPager.PageSizeChoices).toContain(QueryPager.DefaultPageSize)
  })
})
