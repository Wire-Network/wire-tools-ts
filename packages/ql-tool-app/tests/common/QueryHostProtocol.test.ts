import { QueryHostArguments } from "@wireio/ql-tool-app/common"

describe("QueryHostArguments", () => {
  it("names the logs-path flag", () => {
    expect(QueryHostArguments.LogsPathFlag).toBe("--logs-path")
  })
})
