import { QueryErrorKind, type QueryErrorData } from "../protocol/index.js"

/**
 * Retry policy: the server's `retryable` flag is the single source of
 * retryability; the client auto-retries only {@link QueryRetryPolicy.AutoRetryKinds} failures an
 * immediate re-send can plausibly clear. QUERY_TIMEOUT / QUERY_CANCELLED are a
 * user-initiated "Retry", never automatic.
 */
export namespace QueryRetryPolicy {
  /** Kinds that may be auto-retried (only when the server marks the response retryable). */
  export const AutoRetryKinds: readonly QueryErrorKind[] = [
    QueryErrorKind.QUERY_BUSY,
    QueryErrorKind.SCHEMA_CHANGED,
    QueryErrorKind.STATE_UNAVAILABLE
  ] as const
  /** Backoff base; attempt n waits BackoffBaseMs * 2^(n-1), capped at {@link BackoffMaxMs}. */
  export const BackoffBaseMs = 250
  /** Backoff ceiling. */
  export const BackoffMaxMs = 2_000

  /**
   * Auto-retry decision: server says retryable AND the kind is in the auto set.
   *
   * @param data - The engine failure's `error.data`.
   * @returns Whether the client should re-send automatically.
   */
  export function shouldAutoRetry(data: QueryErrorData): boolean {
    return data.retryable && AutoRetryKinds.includes(data.kind)
  }

  /**
   * User-facing "Retry" affordance: exactly the server's flag.
   *
   * @param data - The engine failure's `error.data`.
   * @returns Whether a manual retry is offered.
   */
  export function canRetry(data: QueryErrorData): boolean {
    return data.retryable
  }

  /**
   * Backoff before auto-retry attempt `attempt` (1-based count of retries so far).
   *
   * @param attempt - The 1-based retry number.
   * @returns Delay in ms.
   */
  export function backoffMs(attempt: number): number {
    return Math.min(BackoffBaseMs * 2 ** (attempt - 1), BackoffMaxMs)
  }
}
