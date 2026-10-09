import { NestedError } from "@wireio/shared"

/** Construction input for {@link QueryTransportError}. */
export interface QueryTransportErrorInit {
  /** The execute URL that was called. */
  url: string
  /** HTTP status, or null when no response arrived. */
  status: number
  /** The JSON-RPC id of the request. */
  requestId: string
  /** The originating error, when wrapping one. */
  cause?: unknown
}

/**
 * Transport/envelope failure talking to the engine — fetch rejection, non-2xx,
 * HTTP 204, malformed envelope, id mismatch, unsupported schema version or the
 * client transport timeout. NOT an engine `error` (see {@link QueryEngineError}).
 */
export class QueryTransportError extends NestedError {
  /** The execute URL that was called. */
  readonly url: string
  /** HTTP status, or null when no response arrived. */
  readonly status: number
  /** The JSON-RPC id of the request. */
  readonly requestId: string
  /** The client-side message, without the folded context. */
  readonly detail: string

  /**
   * @param message - What failed.
   * @param init - URL, status, request id and an optional cause.
   */
  constructor(message: string, init: QueryTransportErrorInit) {
    const { url, status, requestId, cause } = init
    super(message, { cause, context: { url, status, requestId } })
    this.name = "QueryTransportError"
    this.url = url
    this.status = status
    this.requestId = requestId
    this.detail = message
  }
}
