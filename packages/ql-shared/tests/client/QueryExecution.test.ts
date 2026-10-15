import {
  QueryEngineClient,
  QueryExecutionStatus,
  QueryFailureKind,
  type QueryExecution
} from "@wireio/ql-shared"

import { createResult, createSuccess, SampleColumns, SampleRows } from "../common/resultFixtures.js"

describe("QueryExecution", () => {
  it("discriminates success and failure by status and survives structured clone", () => {
    const success: QueryExecution = createSuccess(createResult(SampleColumns, SampleRows)),
      failure: QueryExecution = {
        status: QueryExecutionStatus.failure,
        requestId: "r",
        query: "q",
        wallTimeMs: 1,
        attempts: 1,
        failure: QueryEngineClient.cancelledFailure()
      }
    expect(structuredClone(success)).toEqual(success)
    expect(structuredClone(failure)).toEqual(failure)
    const labels = [success, failure].map(execution =>
      execution.status === QueryExecutionStatus.success ? execution.result.page.total_rows : execution.failure.kind
    )
    expect(labels).toEqual(["3", QueryFailureKind.cancelled])
  })

  it("a cancelled failure carries no engine fields", () => {
    expect(QueryEngineClient.cancelledFailure()).toEqual({
      kind: QueryFailureKind.cancelled,
      message: QueryEngineClient.CancelledMessage,
      code: null,
      data: null
    })
  })
})
