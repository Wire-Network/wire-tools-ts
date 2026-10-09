import { match, P } from "ts-pattern"

import { NestedError } from "@wireio/shared"

import { QueryEngineError, QueryFailureError, QueryTransportError } from "../errors/index.js"
import type { QueryErrorCode, QueryErrorData } from "../protocol/index.js"
import { QueryEngineClient } from "./QueryEngineClient.js"
import { QueryFailureKind } from "./QueryExecution.js"

/**
 * Serializable failure (crosses the GUI MessagePort as structured-clone data and
 * is persisted in tab state). `code` and `data` are the engine's `error.code`
 * and `error.data` for `engine` failures, and an EXPLICIT null otherwise — a
 * present null survives structured clone and JSON, an absent key does not.
 */
export interface QueryFailure {
  /** Failure class. */
  kind: QueryFailureKind
  /** Human-readable message (engine message, plus any client hint). */
  message: string
  /** JSON-RPC error code — `engine` failures, else null. */
  code: QueryErrorCode
  /** The engine's `error.data` (kind, retryable, 1-based position, limit name) — `engine` failures, else null. */
  data: QueryErrorData
}

/** Classification of thrown values into {@link QueryFailure}s. */
export namespace QueryFailure {
  /** `Error.name` of an aborted fetch / `AbortSignal` reason. */
  export const AbortErrorName = "AbortError"

  /**
   * A transport-class failure carrying `message` (a lost query port, a crashed
   * host, any error that is neither an engine error nor a cancellation).
   *
   * @param message - What happened.
   * @returns The failure.
   */
  export function transport(message: string): QueryFailure {
    return { kind: QueryFailureKind.transport, message, code: null, data: null }
  }

  /**
   * The failure a thrown value stands for: a {@link QueryFailureError}'s own
   * failure; an engine / transport error or an abort through the
   * `QueryEngineClient` builders; a `NestedError` by the first classified
   * error in its cause chain; anything else as a transport failure carrying
   * the error's message.
   *
   * @param error - The caught value.
   * @returns The failure.
   */
  export function of(error: unknown): QueryFailure {
    return classified(error) ?? transport(NestedError.toError(error).message)
  }

  /**
   * The failure of a value that IS classified (itself or through its causes).
   *
   * @param error - The caught value.
   * @returns The failure, or null when nothing in the chain is classified.
   */
  function classified(error: unknown): QueryFailure {
    return match(error)
      .with(P.instanceOf(QueryFailureError), failed => failed.failure)
      .with(P.instanceOf(QueryEngineError), engine => QueryEngineClient.engineFailure(engine))
      .with(P.instanceOf(QueryTransportError), transportError => QueryEngineClient.transportFailure(transportError))
      .with({ name: AbortErrorName }, () => QueryEngineClient.cancelledFailure())
      .with(P.instanceOf(NestedError), nested =>
        nested.causes.reduce<QueryFailure>((found, cause) => found ?? classified(cause), null)
      )
      .otherwise(() => null)
  }
}
