import { QueryFailure, QueryFailureError } from "@wireio/ql-shared"

/**
 * A query-port call that could not complete: the host answered `failed` (the
 * received failure is carried unchanged — an engine failure keeps its kind,
 * code and retryability), the port was lost, or the call was cancelled before
 * it was sent. `QueryFailure.of` returns its `failure` as-is.
 */
export class QueryPortError extends QueryFailureError {
  /**
   * @param failure - The failure the call ended with.
   */
  constructor(failure: QueryFailure) {
    super(failure.message, { failure })
    this.name = "QueryPortError"
  }
}

/** Port-loss messages and their errors. */
export namespace QueryPortError {
  /** A newer port replaced the one a call was sent on. */
  export const HostRestarted = "query host restarted"
  /** The query host exited unexpectedly (it respawns). */
  export const HostExited = "query host exited"
  /** The query host crash-looped; Restart is required. */
  export const HostFailed = "query host failed"

  /**
   * The error of a call lost with its port (a transport failure).
   *
   * @param message - {@link HostRestarted}, {@link HostExited} or {@link HostFailed}.
   * @returns The error.
   */
  export function lost(message: string): QueryPortError {
    return new QueryPortError(QueryFailure.transport(message))
  }
}
