import {
  QueryExecutionStatus,
  QueryFailureKind,
  QueryErrorCode,
  QueryErrorKind,
  type QueryExecution,
  type QueryExecutionFailure,
  type QueryExecutionSuccess,
  type QueryRequestParams
} from "@wireio/ql-shared"

import { StubQueryEngine } from "./StubQueryEngine.js"

/** Query executions built from the stub engine's own result shapes. */
export namespace ExecutionFixtures {
  /** The SQL of the default fixture. */
  export const PositionsQuery = `SELECT * FROM ${StubQueryEngine.Owner}.positions`

  /**
   * A successful execution over a stub table.
   *
   * @param requestId - Correlation id.
   * @param table - Stub table (default positions).
   * @param params - Window params.
   * @param blockNumber - Answering block.
   * @returns The execution.
   */
  export function success(
    requestId: string,
    table = StubQueryEngine.Positions,
    params: Partial<QueryRequestParams> = {},
    blockNumber: number = StubQueryEngine.FirstBlock
  ): QueryExecutionSuccess {
    return {
      status: QueryExecutionStatus.success,
      requestId,
      query: PositionsQuery,
      wallTimeMs: 4.25,
      attempts: 1,
      result: StubQueryEngine.resultOf(table, { query: PositionsQuery, ...params } as QueryRequestParams, blockNumber)
    }
  }

  /**
   * A failed execution.
   *
   * @param requestId - Correlation id.
   * @param kind - Failure class.
   * @param retryable - Server retryable flag (engine failures only).
   * @returns The execution.
   */
  export function failure(
    requestId: string,
    kind: QueryFailureKind = QueryFailureKind.engine,
    retryable = false
  ): QueryExecutionFailure {
    return {
      status: QueryExecutionStatus.failure,
      requestId,
      query: PositionsQuery,
      wallTimeMs: 2,
      attempts: 1,
      failure:
        kind === QueryFailureKind.engine
          ? {
              kind,
              message: "JOIN is not supported",
              code: QueryErrorCode.QUERY_SYNTAX,
              data: { kind: QueryErrorKind.QUERY_SYNTAX, retryable, line: 1, column: 30, limit: null }
            }
          : { kind, message: "JOIN is not supported", code: null, data: null }
    }
  }

  /**
   * The stub's 10 000-row table.
   *
   * @returns The table.
   */
  export function bigTable(): typeof StubQueryEngine.Big {
    return StubQueryEngine.Big
  }

  /** Narrow helper for tests reading the union. */
  export function asExecution(execution: QueryExecutionSuccess | QueryExecutionFailure): QueryExecution {
    return execution
  }
}
