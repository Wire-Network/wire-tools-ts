import { NestedError } from "@wireio/shared"

import type { QueryErrorCode, QueryErrorData } from "../protocol/index.js"

/** Construction input for {@link QueryEngineError}. */
export interface QueryEngineErrorInit {
  /** JSON-RPC error code (`error.code`). */
  code: QueryErrorCode
  /** The engine's `error.data` (kind, advisory retryability, position, limit name). */
  data: QueryErrorData
  /** The JSON-RPC id of the failed request. */
  requestId: string
  /** The originating error, when wrapping one. */
  cause?: unknown
}

/** A JSON-RPC `error` returned by `query.execute`. */
export class QueryEngineError extends NestedError {
  /** JSON-RPC error code (typed enum). */
  readonly code: QueryErrorCode
  /**
   * The engine's `error.data` — `data.retryable` is the SERVER's advisory
   * retryability (the single source of truth for "may be retried").
   */
  readonly data: QueryErrorData
  /** The JSON-RPC id of the failed request. */
  readonly requestId: string
  /** The engine's own message (plus any client hint), without the folded context. */
  readonly engineMessage: string

  /**
   * @param message - The error message (normally the engine message, plus any client hint).
   * @param init - The error code, the engine error data, the request id and an optional cause.
   */
  constructor(message: string, init: QueryEngineErrorInit) {
    const { code, data, requestId, cause } = init
    super(message, {
      cause,
      context: { kind: data.kind, code, limit: data.limit, requestId }
    })
    this.name = "QueryEngineError"
    this.code = code
    this.data = data
    this.requestId = requestId
    this.engineMessage = message
  }
}
