import { CatalogFieldRole, LogicalType, QueryEngineClient, QueryErrorKind, QueryFailure } from "@wireio/ql-shared"

import { DisplayText } from "@wireio/ql-tool-app/renderer/common"

import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"

describe("DisplayText.fieldType", () => {
  it("is the ABI type, plus the logical type once described", () => {
    const field = { path: "amount", role: CatalogFieldRole.value, abiType: "int64", logicalType: null as LogicalType }
    expect(DisplayText.fieldType(field)).toBe("int64")
    expect(DisplayText.fieldType({ ...field, logicalType: LogicalType.integer })).toBe(`int64${DisplayText.TypeSeparator}integer`)
  })
})

describe("DisplayText.failureLine", () => {
  it("leads with the engine error kind, else the failure class", () => {
    expect(DisplayText.failureLine(ExecutionFixtures.failure("r").failure)).toBe(`${QueryErrorKind.QUERY_SYNTAX}: JOIN is not supported`)
    expect(DisplayText.failureLine(QueryFailure.transport("query host exited"))).toBe("transport: query host exited")
    expect(DisplayText.failureLine(QueryEngineClient.cancelledFailure())).toBe(`cancelled: ${QueryEngineClient.CancelledMessage}`)
  })
})
