import { QueryErrorKind, QueryRetryPolicy } from "@wireio/ql-shared"

import { createErrorData } from "../common/errorFixtures.js"

const engineError = (kind: QueryErrorKind, retryable: boolean) => createErrorData(kind, { retryable })

describe("QueryRetryPolicy", () => {
  it.each(QueryRetryPolicy.AutoRetryKinds)("auto-retries retryable %s", kind => {
    expect(QueryRetryPolicy.shouldAutoRetry(engineError(kind, true))).toBe(true)
    expect(QueryRetryPolicy.canRetry(engineError(kind, true))).toBe(true)
  })

  it("never auto-retries TIMEOUT / CANCELLED, but offers a manual retry when retryable", () => {
    ;[QueryErrorKind.QUERY_TIMEOUT, QueryErrorKind.QUERY_CANCELLED].forEach(kind => {
      expect(QueryRetryPolicy.shouldAutoRetry(engineError(kind, true))).toBe(false)
      expect(QueryRetryPolicy.canRetry(engineError(kind, true))).toBe(true)
    })
  })

  it("never retries when the server says retryable:false", () => {
    expect(QueryRetryPolicy.shouldAutoRetry(engineError(QueryErrorKind.QUERY_BUSY, false))).toBe(false)
    expect(QueryRetryPolicy.canRetry(engineError(QueryErrorKind.QUERY_BUSY, false))).toBe(false)
  })

  it("backs off exponentially up to the ceiling", () => {
    expect(QueryRetryPolicy.backoffMs(1)).toBe(QueryRetryPolicy.BackoffBaseMs)
    expect(QueryRetryPolicy.backoffMs(2)).toBe(QueryRetryPolicy.BackoffBaseMs * 2)
    expect(QueryRetryPolicy.backoffMs(10)).toBe(QueryRetryPolicy.BackoffMaxMs)
  })
})
