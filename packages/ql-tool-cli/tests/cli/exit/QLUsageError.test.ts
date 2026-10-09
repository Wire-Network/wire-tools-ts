import { NestedError } from "@wireio/shared"

import { QLUsageError } from "@wireio/ql-tool-cli/cli/index.js"

describe("QLUsageError", () => {
  it("is a NestedError carrying its message", () => {
    const error = new QLUsageError("no query")
    expect(error).toBeInstanceOf(NestedError)
    expect(error.message).toContain("no query")
  })

  it("preserves its cause", () => {
    const cause = new Error("root"),
      error = new QLUsageError("wrapped", { cause })
    expect(error.cause).toBe(cause)
  })
})
