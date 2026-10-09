import {
  QueryEngineError,
  QueryErrorCode,
  QueryErrorKind,
  type QueryErrorData
} from "@wireio/ql-shared"

/** Overrides of {@link createEngineError}. */
export interface EngineErrorOverrides {
  /** `error.data` members to replace. */
  data?: Partial<QueryErrorData>
  /** Request id (default `r`). */
  requestId?: string
  /** Message (default: the kind). */
  message?: string
  /** Optional cause. */
  cause?: unknown
}

/** Request id of every fixture error unless overridden. */
export const FixtureRequestId = "r"

/**
 * The engine `error.data` of a kind (non-positional, not retryable, no limit).
 *
 * @param kind - Engine error kind.
 * @param overrides - Members to replace.
 * @returns The data.
 */
export function createErrorData(kind: QueryErrorKind, overrides: Partial<QueryErrorData> = {}): QueryErrorData {
  return { kind, retryable: false, line: null, column: null, limit: null, ...overrides }
}

/**
 * A {@link QueryEngineError} of a kind, its code derived from the kind.
 *
 * @param kind - Engine error kind.
 * @param overrides - Data / request id / message / cause overrides.
 * @returns The error.
 */
export function createEngineError(
  kind: QueryErrorKind = QueryErrorKind.QUERY_SYNTAX,
  overrides: EngineErrorOverrides = {}
): QueryEngineError {
  const { data = {}, requestId = FixtureRequestId, message = kind, cause } = overrides
  return new QueryEngineError(message, {
    code: QueryErrorCode[kind],
    data: createErrorData(kind, data),
    requestId,
    cause
  })
}
