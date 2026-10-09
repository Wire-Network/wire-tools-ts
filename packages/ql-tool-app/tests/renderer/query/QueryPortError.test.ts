import { NestedError } from "@wireio/shared"
import { QueryEngineClient, QueryFailure, QueryFailureError, QueryFailureKind } from "@wireio/ql-shared"

import { QueryPortError, QueryPortEventType } from "@wireio/ql-tool-app/renderer/query"

describe("QueryPortError", () => {
  it("carries the failure it was given unchanged (QueryFailure.of returns it)", () => {
    const failure = QueryEngineClient.cancelledFailure(),
      error = new QueryPortError(failure)
    expect(error).toBeInstanceOf(QueryFailureError)
    expect(error).toBeInstanceOf(NestedError)
    expect(error.name).toBe("QueryPortError")
    expect(error.failure).toBe(failure)
    expect(error.message).toContain(failure.message)
    expect(QueryFailure.of(error)).toBe(failure)
  })

  it("lost builds a serializable transport failure with the port-loss message", () => {
    const error = QueryPortError.lost(QueryPortError.HostRestarted)
    expect(error.failure).toEqual({ kind: QueryFailureKind.transport, message: QueryPortError.HostRestarted, code: null, data: null })
    expect(JSON.parse(JSON.stringify(error.failure))).toEqual(error.failure)
  })

  it("the three port messages are distinct", () => {
    expect(new Set([QueryPortError.HostRestarted, QueryPortError.HostExited, QueryPortError.HostFailed]).size).toBe(3)
    expect(QueryPortEventType.message).toBe("message")
  })
})
