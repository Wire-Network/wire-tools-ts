import {
  QueryPageSchema,
  QueryResultCodec,
  QueryResultPatterns,
  QueryResultShape,
  type QueryResult
} from "@wireio/ql-shared"

import { createResult, readEngineExample, SampleColumns, SampleRows } from "../common/resultFixtures.js"

const exampleResult = (name: string): QueryResult => JSON.parse(readEngineExample(name)).result

describe("QueryResult", () => {
  it.each(["response.json", "response-paged.json"])("decodes the engine example %s", name => {
    const result = exampleResult(name)
    expect(QueryResultCodec.check(result)).toBe(true)
    expect(QueryResultCodec.deserialize(JSON.stringify(result))).toEqual(result)
  })

  it("decodes a fixture with asset, null and nested cells", () => {
    expect(QueryResultCodec.check(createResult(SampleColumns, SampleRows))).toBe(true)
  })

  it.each([
    ["numeric block_num", (result: QueryResult) => ({ ...result, state: { ...result.state, block_num: 42 } })],
    ["complete:false", (result: QueryResult) => ({ ...result, complete: false })],
    ["schema_version 1.0", (result: QueryResult) => ({ ...result, schema_version: "1.0" })],
    ["missing stats", ({ stats: _stats, ...rest }: QueryResult) => rest],
    ["missing page", ({ page: _page, ...rest }: QueryResult) => rest],
    ["extra column key", (result: QueryResult) => ({ ...result, rows: [{ ...result.rows[0], extra: "1" }] })],
    ["missing row key", (result: QueryResult) => ({ ...result, rows: [{ beneficiary: "alice" }] })],
    ["no columns", (result: QueryResult) => ({ ...result, columns: [], rows: [] })]
  ])("rejects %s", (_name, mutate) => {
    expect(QueryResultCodec.check(mutate(exampleResult("response.json")))).toBe(false)
  })

  it("reports the offending row index", () => {
    const issues: unknown[] = [],
      context = { addIssue: (issue: unknown) => issues.push(issue) } as unknown as Parameters<typeof QueryResultShape.refineRowKeys>[1]
    QueryResultShape.refineRowKeys({ columns: SampleColumns, rows: [SampleRows[0], { name: "x" }] }, context)
    expect(issues).toEqual([expect.objectContaining({ path: ["rows", 1] })])
  })
})

describe("QueryPage", () => {
  it("decodes a page without limit", () => {
    expect(
      QueryPageSchema.safeParse({ offset: "0", limit: null, returned_rows: "1", total_rows: "1", has_more: false }).success
    ).toBe(true)
  })

  it("rejects numeric counters and extra keys", () => {
    expect(QueryPageSchema.safeParse({ offset: 0, limit: null, returned_rows: "1", total_rows: "1", has_more: false }).success).toBe(false)
    expect(
      QueryPageSchema.safeParse({ offset: "0", limit: null, returned_rows: "1", total_rows: "1", has_more: false, extra: 1 }).success
    ).toBe(false)
  })
})

describe("QueryResultPatterns", () => {
  it("matches the engine's lexical forms", () => {
    expect(QueryResultPatterns.UnsignedDecimal.test("0")).toBe(true)
    expect(QueryResultPatterns.UnsignedDecimal.test("01")).toBe(false)
    expect(QueryResultPatterns.SignedDecimal.test("-10.25")).toBe(true)
    expect(QueryResultPatterns.SignedDecimal.test("1e2")).toBe(false)
    expect(QueryResultPatterns.IeeeHex.test("0x0000c03f")).toBe(true)
    expect(QueryResultPatterns.IeeeHex.test("0x0")).toBe(false)
  })
})
