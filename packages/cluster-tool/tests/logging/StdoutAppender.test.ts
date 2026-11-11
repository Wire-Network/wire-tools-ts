import type { LogRecord } from "@wireio/shared"
import { StdoutAppender } from "@wireio/cluster-tool/logging"

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

  it("writes a stdout:<name> sub-category record raw too", () => {
    new StdoutAppender().append(
      record({ category: StdoutAppender.category("listing"), message: "row" })
    )
    expect(spy).toHaveBeenCalledWith("row\n")
  })

  describe("isStdoutCategory", () => {
    it("is true for the category itself and its stdout:<name> sub-categories", () => {
      expect(StdoutAppender.isStdoutCategory(StdoutAppender.Category)).toBe(true)
      expect(StdoutAppender.isStdoutCategory("stdout:listing")).toBe(true)
      expect(StdoutAppender.isStdoutCategory("stdout:a:b")).toBe(true)
    })

    it("is false for a prefix lookalike, a diagnostic category and an empty category", () => {
      expect(StdoutAppender.isStdoutCategory("stdoutx")).toBe(false)
      expect(StdoutAppender.isStdoutCategory("stdout-listing")).toBe(false)
      expect(StdoutAppender.isStdoutCategory("cli:CreateCommand")).toBe(false)
      expect(StdoutAppender.isStdoutCategory("")).toBe(false)
    })
  })

  describe("category", () => {
    it("is the bare category without a name, stdout:<name> with one", () => {
      expect(StdoutAppender.category()).toBe("stdout")
      expect(StdoutAppender.category("listing")).toBe("stdout:listing")
      expect(StdoutAppender.category(undefined)).toBe(StdoutAppender.Category)
    })

    it("every category it renders is recognized by isStdoutCategory", () => {
      ;[undefined, "listing", "keys"].forEach(name =>
        expect(StdoutAppender.isStdoutCategory(StdoutAppender.category(name))).toBe(
          true
        )
      )
    })
  })
})
