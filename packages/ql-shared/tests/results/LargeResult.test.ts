import { range } from "lodash"

import {
  LogicalType,
  OutputFormat,
  PageSizeMode,
  QueryPager,
  QueryResultCodec,
  ResultRenderer,
  ResultView,
  SortDirection,
  type QueryRow
} from "@wireio/ql-shared"

import { column, createResult, createSuccess } from "../common/resultFixtures.js"

/** Rows and columns of the large fixture (the bench measures the same shape). */
const RowCount = 10_000
const ColumnCount = 12

describe("large result correctness (10k × 12)", () => {
  const columns = range(ColumnCount).map(index => column(`c${index}`, index % 2 === 0 ? LogicalType.integer : LogicalType.text)),
    rows: QueryRow[] = range(RowCount).map(rowIndex =>
      Object.fromEntries(columns.map((target, index) => [target.name, index % 2 === 0 ? String(rowIndex * index) : `r${rowIndex}`]))
    ),
    result = createResult(columns, rows)

  it("decodes, views, pages and renders with the expected counts", () => {
    const decoded = QueryResultCodec.deserialize(JSON.stringify(result)),
      view = ResultView.create(decoded, { sorts: [{ column: "c2", direction: SortDirection.desc }] }),
      pager = new QueryPager({ pageSize: 500, page: 3 }),
      csv = ResultRenderer.render(OutputFormat.csv, { execution: createSuccess(decoded), view, range: view.fullRange() })
    expect(decoded.rows).toHaveLength(RowCount)
    expect(view.row(0).c2).toBe(String((RowCount - 1) * 2))
    expect(pager.window).toEqual({ limit: 500, offset: 1_000 })
    expect(new QueryPager({ mode: PageSizeMode.all }).window.limit).toBeNull()
    expect(csv.split("\n")).toHaveLength(RowCount + 2)
    expect(structuredClone(createSuccess(decoded)).result.rows).toHaveLength(RowCount)
  })
})
