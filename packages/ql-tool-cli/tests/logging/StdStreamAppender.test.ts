import { getLogger, getLoggingManager, Level, type LogRecord } from "@wireio/shared"

import { getStderrLogger, getStdoutLogger, hasStream, isStdoutTTY, StdStreamAppender, StreamCategory } from "@wireio/ql-tool-cli/logger.js"

describe("StdStreamAppender", () => {
  let stdoutWrite: jest.SpyInstance
  let stderrWrite: jest.SpyInstance

  beforeEach(() => {
    stdoutWrite = jest.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrWrite = jest.spyOn(process.stderr, "write").mockImplementation(() => true)
    getLoggingManager().setAppenders(new StdStreamAppender())
  })

  afterEach(() => {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
    getLoggingManager().setRootLevel(Level.info)
  })

  it("writes the stdout channel raw to stdout and the stderr channel raw to stderr", () => {
    getStdoutLogger().info("data line")
    getStderrLogger("hint").warn("a hint")
    expect(stdoutWrite).toHaveBeenCalledWith("data line\n")
    expect(stderrWrite).toHaveBeenCalledWith("a hint\n")
  })

  it("formats diagnostics onto stderr with the category, never stdout", () => {
    getLogger("cli:commands:QueryCommand").warn("careful", { n: 1 })
    expect(stderrWrite).toHaveBeenCalledWith('[cli:commands:QueryCommand] (warn) careful {"n":1}\n')
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it("formats a diagnostic without arguments with no trailing suffix", () => {
    getLogger("x:y").warn("plain")
    expect(stderrWrite).toHaveBeenCalledWith("[x:y] (warn) plain\n")
  })

  it("argsSuffix keeps strings as-is and JSON-encodes the rest; empty without arguments", () => {
    const record = (args: unknown[]) => ({ category: "c", level: Level.info, message: "m", args }) as unknown as LogRecord
    expect(StdStreamAppender.argsSuffix(record(["a", 1, { b: true }]))).toBe(' a 1 {"b":true}')
    expect(StdStreamAppender.argsSuffix(record([]))).toBe("")
    expect(StdStreamAppender.argsSuffix(record(undefined))).toBe("")
  })

  it("install() makes a StdStreamAppender the only appender (repeat installs route the same way)", () => {
    const manager = getLoggingManager()
    manager.setAppenders({ append: jest.fn() })
    StdStreamAppender.install()
    StdStreamAppender.install()
    expect(manager.appenders).toHaveLength(1)
    expect(manager.appenders[0]).toBeInstanceOf(StdStreamAppender)
  })

  it("keeps the data channels unfiltered at any root level", () => {
    getLoggingManager().setRootLevel(Level.fatal)
    getStdoutLogger().info("still printed")
    getLogger("x:y").info("filtered")
    expect(stdoutWrite).toHaveBeenCalledWith("still printed\n")
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})

describe("isStdoutTTY", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

  afterEach(() => {
    if (original == null) Reflect.deleteProperty(process.stdout, "isTTY")
    else Object.defineProperty(process.stdout, "isTTY", original)
  })

  it("is true only when stdout.isTTY is exactly true", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    expect(isStdoutTTY()).toBe(true)
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true })
    expect(isStdoutTTY()).toBe(false)
  })

  it("hasStream matches a stream and its sub-categories only", () => {
    expect(hasStream(StreamCategory.stdout, StreamCategory.stdout)).toBe(true)
    expect(hasStream("stdout:table", StreamCategory.stdout)).toBe(true)
    expect(hasStream("stdoutish", StreamCategory.stdout)).toBe(false)
    expect(hasStream("stdout:table", StreamCategory.stderr)).toBe(false)
    expect(Object.values(StreamCategory)).toEqual(["stdout", "stderr"])
  })
})
