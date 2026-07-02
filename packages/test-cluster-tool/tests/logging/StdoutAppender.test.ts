import type { LogRecord } from "@wireio/shared"
import { StdoutAppender } from "@wireio/test-cluster-tool/logging"

const record = (over: Partial<LogRecord>): LogRecord => ({
  timestamp: 0,
  category: "x",
  level: "info",
  message: "m",
  ...over
})

describe("StdoutAppender", () => {
  let spy: jest.SpyInstance
  beforeEach(() => {
    spy = jest.spyOn(process.stdout, "write").mockReturnValue(true)
  })
  afterEach(() => {
    spy.mockRestore()
  })

  it("writes the raw message plus a newline for the stdout category", () => {
    new StdoutAppender().append(
      record({ category: StdoutAppender.Category, message: "hello" })
    )
    expect(spy).toHaveBeenCalledWith("hello\n")
  })

  it("ignores records of any other category", () => {
    new StdoutAppender().append(record({ category: "other", message: "nope" }))
    expect(spy).not.toHaveBeenCalled()
  })
})
