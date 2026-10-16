import { NestedError, type NestedErrorContext } from "@wireio/shared"

import type { QueryFailure } from "../client/QueryFailure.js"

/** Construction input for {@link QueryFailureError}. */
export interface QueryFailureErrorInit {
  /** The serializable failure the error carries unchanged. */
  failure: QueryFailure
  /** The originating error, when wrapping one. */
  cause?: unknown
  /** Diagnostic context folded into the message (the failure itself is a property, never folded). */
  context?: NestedErrorContext
}

/**
 * An error that carries an already-classified {@link QueryFailure} — an engine
 * or transport outcome that has to travel as a throw (a describe probe that
 * failed, a query-port call answered with a failure). `QueryFailure.of`
 * returns its `failure` as-is, so the engine kind, code and retryability are
 * never re-derived from the message.
 */
export class QueryFailureError extends NestedError {
  /** The carried failure. */
  readonly failure: QueryFailure

  /**
   * @param message - The error message.
   * @param init - The failure, an optional cause and extra context.
   */
  constructor(message: string, init: QueryFailureErrorInit) {
    const { failure, cause, context } = init
    super(message, { cause, context })
    this.name = "QueryFailureError"
    this.failure = failure
  }
}
