import { getLogger } from "@wireio/shared"

import {
  LogicalType,
  OutputFormat,
  QueryEngineRPC,
  QueryExecutionStatus,
  QueryPager,
  QueryResultCodec,
  ResultRenderer,
  ResultView,
  SortDirection,
  ValueEncoding,
  type QueryColumn,
  type QueryExecutionSuccess,
  type QueryResult
} from "@wireio/ql-shared"

const log = getLogger(__filename)

/** Rows of the measured result. */
const RowCount = 10_000
/** Columns of the measured result. */
const ColumnCount = 12
/** 64 hex characters. */
const Hash = "a".repeat(64)

/** Time one stage (ms) and log it. */
function measure<T>(label: string, stage: () => T): T {
  const started = performance.now(),
    value = stage()
  log.info(`${label.padEnd(28)} ${(performance.now() - started).toFixed(1)} ms`)
  return value
}

const columns: QueryColumn[] = Array.from({ length: ColumnCount }, (_value, index) => index).map(index => ({
    name: `c${index}`,
    logical_type: index % 2 === 0 ? LogicalType.integer : LogicalType.text,
    abi_type: null,
    nullable: false,
    encoding: index % 2 === 0 ? ValueEncoding.decimal_string : ValueEncoding.text
  })),
  result = {
    schema_version: QueryEngineRPC.SchemaVersion,
    complete: true,
    source: { owners: ["sample"], table: "positions" },
    state: {
      chain_id: Hash,
      block_id: Hash,
      block_num: "1",
      block_time: "2026-10-07T00:00:00",
      read_mode: "head",
      last_irreversible_block_num: "1",
      abis: [{ owner: "sample", hash: Hash }],
      captured_at: "2026-10-07T00:00:00Z",
      synced: true
    },
    columns,
    rows: Array.from({ length: RowCount }, (_value, index) => index).map(row =>
      Object.fromEntries(columns.map((column, index) => [column.name, index % 2 === 0 ? String(row * index) : `row ${row}`]))
    ),
    stats: { scanned_rows: "1", matched_rows: "1", groups: "0", returned_rows: String(RowCount), raw_bytes: "1", elapsed_us: "1" },
    page: { offset: "0", limit: null, returned_rows: String(RowCount), total_rows: String(RowCount), has_more: false }
  } as QueryResult,
  text = JSON.stringify(result),
  decoded = measure("decode (zod, shallow rows)", () => QueryResultCodec.deserialize(text)),
  execution: QueryExecutionSuccess = {
    status: QueryExecutionStatus.success,
    requestId: "bench",
    query: "SELECT *",
    wallTimeMs: 0,
    attempts: 1,
    result: decoded
  },
  view = measure("view (sort c2 desc)", () => ResultView.create(decoded, { sorts: [{ column: "c2", direction: SortDirection.desc }] })),
  pager = new QueryPager({ pageSize: QueryPager.DefaultPageSize })

measure("page window", () => pager.withPage(50).window)
measure("render table (all rows)", () => ResultRenderer.render(OutputFormat.table, { execution, view, range: view.fullRange() }))
measure("structuredClone execution", () => structuredClone(execution))
