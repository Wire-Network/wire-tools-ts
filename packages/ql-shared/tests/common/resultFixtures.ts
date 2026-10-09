import Fs from "node:fs"
import Path from "node:path"

import {
  LogicalType,
  QueryEngineRPC,
  QueryExecutionStatus,
  ValueEncoding,
  type CellValue,
  type QueryColumn,
  type QueryExecutionSuccess,
  type QueryResult,
  type QueryRow
} from "@wireio/ql-shared"

/** Directory of the committed engine fixtures. */
export const EngineFixturesPath = Path.join(__dirname, "..", "fixtures", "engine")

/**
 * Read one committed engine example.
 *
 * @param name - File name under `examples/`.
 * @returns Its text.
 */
export function readEngineExample(name: string): string {
  return Fs.readFileSync(Path.join(EngineFixturesPath, "examples", name), "utf8")
}

/** Encoding of each logical type. */
const EncodingOf: Record<LogicalType, ValueEncoding> = {
  [LogicalType.integer]: ValueEncoding.decimal_string,
  [LogicalType.decimal]: ValueEncoding.decimal_string,
  [LogicalType.boolean]: ValueEncoding.boolean,
  [LogicalType.text]: ValueEncoding.text,
  [LogicalType.time]: ValueEncoding.text,
  [LogicalType.asset]: ValueEncoding.asset_object,
  [LogicalType.extended_asset]: ValueEncoding.asset_object,
  [LogicalType.json]: ValueEncoding.json,
  [LogicalType.ieee_hex]: ValueEncoding.ieee_hex,
  [LogicalType.enumeration]: ValueEncoding.text
}

/**
 * A column of a logical type.
 *
 * @param name - Column name.
 * @param logicalType - Logical type.
 * @returns The column.
 */
export function column(name: string, logicalType: LogicalType): QueryColumn {
  return { name, logical_type: logicalType, abi_type: null, nullable: true, encoding: EncodingOf[logicalType] }
}

/** Hex of 64 characters. */
export const Hash64 = "a".repeat(64)

/**
 * A complete, valid result.
 *
 * @param columns - Columns.
 * @param rows - Rows.
 * @param total - page.total_rows (default rows.length).
 * @returns The result.
 */
export function createResult(columns: QueryColumn[], rows: QueryRow[], total: number = rows.length): QueryResult {
  return {
    schema_version: QueryEngineRPC.SchemaVersion,
    complete: true,
    source: { owners: ["sample"], table: "positions" },
    state: {
      chain_id: Hash64,
      block_id: Hash64,
      block_num: "42",
      block_time: "2026-09-21T12:00:00.000",
      read_mode: "head",
      last_irreversible_block_num: "40",
      abis: [{ owner: "sample", hash: Hash64 }],
      captured_at: "2026-09-21T12:00:00.050000Z",
      synced: true
    },
    columns,
    rows,
    stats: {
      scanned_rows: String(rows.length),
      matched_rows: String(rows.length),
      groups: "0",
      returned_rows: String(rows.length),
      raw_bytes: "100",
      elapsed_us: "1200"
    },
    page: {
      offset: "0",
      limit: null,
      returned_rows: String(rows.length),
      total_rows: String(total),
      has_more: total > rows.length
    }
  } as QueryResult
}

/**
 * A successful execution around a result.
 *
 * @param result - The result.
 * @returns The execution.
 */
export function createSuccess(result: QueryResult): QueryExecutionSuccess {
  return {
    status: QueryExecutionStatus.success,
    requestId: "request-1",
    query: "SELECT * FROM sample.positions",
    wallTimeMs: 12.5,
    attempts: 1,
    result
  }
}

/** The standard sample: name(text), amount(integer), balance(asset), note(text, nullable). */
export const SampleColumns: QueryColumn[] = [
  column("name", LogicalType.text),
  column("amount", LogicalType.integer),
  column("balance", LogicalType.asset),
  column("note", LogicalType.text)
]

/** Rows of {@link SampleColumns}. */
export const SampleRows: QueryRow[] = [
  { name: "alice", amount: "10", balance: { amount: "1.5", symbol: "SYS", precision: "4" }, note: "first" },
  { name: "bob", amount: "-3", balance: { amount: "20", symbol: "SYS", precision: "4" }, note: null },
  { name: "carol", amount: "250", balance: { amount: "0.25", symbol: "SYS", precision: "4" }, note: "tab\there" }
]

/**
 * One cell value as a CellValue (test convenience).
 *
 * @param value - Any JSON value.
 * @returns The value typed as a cell.
 */
export function cell(value: unknown): CellValue {
  return value as CellValue
}
