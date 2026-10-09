import { match } from "ts-pattern"

import { QueryErrorKind, QueryFailureKind, type QueryFailure } from "@wireio/ql-shared"

/** Process exit codes (numeric enum; the value IS the exit code — documented in the README). */
export enum QLExitCode {
  success = 0,
  failure = 1,
  usage = 2,
  transport = 3,
  querySyntax = 10,
  querySemantics = 11,
  queryLimit = 12,
  queryTimeout = 13,
  queryBusy = 14,
  schemaChanged = 15,
  rowDecode = 16,
  value = 17,
  stateUnavailable = 18,
  cancelled = 19,
  protocol = 20,
  internal = 21,
  interrupted = 130
}

/** Exit-code mappings. */
export namespace QLExitCode {
  /**
   * Engine error kind → exit code (exhaustive; the ONE mapping).
   *
   * @param kind - The engine `error.data.kind`.
   * @returns The exit code.
   */
  export function forKind(kind: QueryErrorKind): QLExitCode {
    return match(kind)
      .with(QueryErrorKind.QUERY_SYNTAX, () => QLExitCode.querySyntax)
      .with(QueryErrorKind.QUERY_SEMANTICS, () => QLExitCode.querySemantics)
      .with(QueryErrorKind.QUERY_LIMIT, () => QLExitCode.queryLimit)
      .with(QueryErrorKind.QUERY_TIMEOUT, () => QLExitCode.queryTimeout)
      .with(QueryErrorKind.QUERY_BUSY, () => QLExitCode.queryBusy)
      .with(QueryErrorKind.SCHEMA_CHANGED, () => QLExitCode.schemaChanged)
      .with(QueryErrorKind.ROW_DECODE_ERROR, () => QLExitCode.rowDecode)
      .with(QueryErrorKind.VALUE_ERROR, () => QLExitCode.value)
      .with(QueryErrorKind.STATE_UNAVAILABLE, () => QLExitCode.stateUnavailable)
      .with(QueryErrorKind.QUERY_CANCELLED, () => QLExitCode.cancelled)
      .with(
        QueryErrorKind.PARSE_ERROR,
        QueryErrorKind.INVALID_REQUEST,
        QueryErrorKind.METHOD_NOT_FOUND,
        QueryErrorKind.INVALID_PARAMS,
        () => QLExitCode.protocol
      )
      .with(QueryErrorKind.INTERNAL_ERROR, () => QLExitCode.internal)
      .exhaustive()
  }

  /**
   * Execution failure → exit code (engine failures by kind; transport; cancelled).
   *
   * @param failure - The failure of an execution.
   * @returns The exit code.
   */
  export function forFailure(failure: QueryFailure): QLExitCode {
    return match(failure.kind)
      .with(QueryFailureKind.engine, () => forKind(failure.data.kind))
      .with(QueryFailureKind.transport, () => QLExitCode.transport)
      .with(QueryFailureKind.cancelled, () => QLExitCode.cancelled)
      .exhaustive()
  }
}
