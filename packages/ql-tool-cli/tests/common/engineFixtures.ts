import { match } from "ts-pattern"

import { NodeopReadMode } from "@wireio/cluster-tool-shared"
import {
  LogicalType,
  QueryEngineRPC,
  QueryErrorCode,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryFailureKind,
  ValueEncoding,
  type QueryColumn,
  type QueryErrorData,
  type QueryExecutionFailure,
  type QueryFailure,
  type QueryExecutionSuccess,
  type QueryResult,
  type QueryRow
} from "@wireio/ql-shared"

/** Overrides of {@link createFailure}: failure members, the engine `data` members partial. */
export interface FailureOverrides extends Partial<Omit<QueryFailure, "data">> {
  /** Engine `error.data` members (engine failures only). */
  data?: Partial<QueryErrorData>
}

/**
 * A failure: an engine `QUERY_SYNTAX` (non-positional, not retryable, message
 * `boom`) unless overridden; a transport / cancelled kind carries explicit null
 * `code` / `data`, like the client's.
 *
 * @param overrides - Kind, message, code and engine data.
 * @returns The failure.
 */
export function createFailure(overrides: FailureOverrides = {}): QueryFailure {
  const { kind = QueryFailureKind.engine, message = "boom", data = {} } = overrides
  return match(kind)
    .with(QueryFailureKind.engine, () => {
      const errorData: QueryErrorData = { kind: QueryErrorKind.QUERY_SYNTAX, retryable: false, line: null, column: null, limit: null, ...data }
      return { kind, message, code: overrides.code ?? QueryErrorCode[errorData.kind], data: errorData }
    })
    .otherwise(() => ({ kind, message, code: null, data: null }))
}

/** 64 hex characters. */
const Hash64 = "a".repeat(64)

/**
 * A column.
 *
 * @param name - Name.
 * @param logicalType - Logical type (integer → decimal_string, text → text).
 * @returns The column.
 */
export function column(name: string, logicalType: LogicalType = LogicalType.text): QueryColumn {
  return {
    name,
    logical_type: logicalType,
    abi_type: null,
    nullable: true,
    encoding: logicalType === LogicalType.integer ? ValueEncoding.decimal_string : ValueEncoding.text
  }
}

/** Options of {@link createResult}. */
export interface ResultFixtureOptions {
  /** page.offset. */
  offset?: number
  /** page.limit (null = none). */
  limit?: number
  /** page.total_rows (default rows.length + offset). */
  total?: number
  /** page.has_more. */
  hasMore?: boolean
}

/**
 * A valid engine result.
 *
 * @param columns - Columns.
 * @param rows - Rows.
 * @param options - Page members.
 * @returns The result.
 */
export function createResult(columns: QueryColumn[], rows: QueryRow[], options: ResultFixtureOptions = {}): QueryResult {
  const { offset = 0, limit = null, total = offset + rows.length, hasMore = false } = options
  return {
    schema_version: QueryEngineRPC.SchemaVersion,
    complete: true,
    source: { owners: ["sample"], table: "positions" },
    state: {
      chain_id: Hash64,
      block_id: Hash64,
      block_num: "42",
      block_time: "2026-09-21T12:00:00.000",
      read_mode: NodeopReadMode.head,
      last_irreversible_block_num: "40",
      abis: [{ owner: "sample", hash: Hash64 }],
      captured_at: "2026-09-21T12:00:00.050000Z",
      synced: true
    },
    columns,
    rows,
    stats: {
      scanned_rows: String(total),
      matched_rows: String(total),
      groups: "0",
      returned_rows: String(rows.length),
      raw_bytes: "100",
      elapsed_us: "900"
    },
    page: {
      offset: String(offset),
      limit: limit == null ? null : String(limit),
      returned_rows: String(rows.length),
      total_rows: String(total),
      has_more: hasMore
    }
  }
}

/** The two-column sample result (`id` integer, `name` text). */
export function sampleResult(options: ResultFixtureOptions = {}): QueryResult {
  return createResult(
    [column("id", LogicalType.integer), column("name")],
    [
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
      { id: "3", name: "carol" }
    ],
    options
  )
}

/**
 * A success execution.
 *
 * @param result - The result.
 * @param query - The SQL text.
 * @returns The execution.
 */
export function successExecution(result: QueryResult = sampleResult(), query = "SELECT * FROM sample.positions"): QueryExecutionSuccess {
  return { status: QueryExecutionStatus.success, requestId: "request-1", query, wallTimeMs: 12.5, attempts: 1, result }
}

/**
 * A failed execution carrying `failure`.
 *
 * @param failure - The failure.
 * @returns The execution.
 */
export function failedExecution(failure: QueryFailure): QueryExecutionFailure {
  return {
    status: QueryExecutionStatus.failure,
    requestId: "request-2",
    query: "SELECT * FROM a.b JOIN c.d",
    wallTimeMs: 3,
    attempts: 1,
    failure
  }
}

/**
 * An engine-failure execution (non-positional, not retryable, no limit unless overridden).
 *
 * @param kind - Engine kind.
 * @param data - `error.data` overrides (position, retryable, limit).
 * @returns The execution.
 */
export function engineFailureExecution(kind: QueryErrorKind, data: Partial<QueryErrorData> = {}): QueryExecutionFailure {
  return failedExecution(createFailure({ data: { ...data, kind } }))
}

/**
 * A non-engine (transport or cancelled) failure execution.
 *
 * @param kind - Failure class.
 * @returns The execution.
 */
export function clientFailureExecution(kind: QueryFailureKind.transport | QueryFailureKind.cancelled): QueryExecutionFailure {
  return failedExecution(createFailure({ kind }))
}
