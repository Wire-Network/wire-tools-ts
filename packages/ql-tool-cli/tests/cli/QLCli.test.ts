import { ProcessSignalName } from "@wireio/cluster-tool-shared"

import { QLCli, QLExitCode, QLUsageError } from "@wireio/ql-tool-cli/cli/index.js"

import { captureLogs, type CapturedLogs } from "../common/logCapture.js"
import { createTestContext } from "../common/testContext.js"

describe("QLCli", () => {
  let logs: CapturedLogs

  beforeEach(() => {
    logs = captureLogs()
  })

  afterEach(() => logs.restore())

  it("onFail: a parser message → usage exit, printed, and thrown to stop yargs", () => {
    const { context } = createTestContext(),
      onFail = QLCli.createFailHandler(context)
    expect(() => onFail("Unknown argument: x", null, null)).toThrow(QLUsageError)
    expect(context.exitCode).toBe(QLExitCode.usage)
    expect(logs.stderr()).toEqual(["error: Unknown argument: x", QLCli.UsageHint])
  })

  it("onFail rethrows a non-usage error untouched", () => {
    const { context } = createTestContext(),
      error = new Error("handler bug")
    expect(() => QLCli.createFailHandler(context)(null, error, null)).toThrow(error)
    expect(context.exitCode).toBe(QLExitCode.success)
  })

  it("handle: usage errors → 2, other errors → 1, success leaves the code", async () => {
    const { context } = createTestContext()
    await QLCli.handle(context, async () => undefined)({})
    expect(context.exitCode).toBe(QLExitCode.success)
    await QLCli.handle(context, async () => {
      throw new QLUsageError("no query")
    })({})
    expect(context.exitCode).toBe(QLExitCode.usage)
    await QLCli.handle(context, async () => {
      throw new Error("disk full")
    })({})
    expect(context.exitCode).toBe(QLExitCode.failure)
    expect(logs.stderr()).toEqual(["error: no query", QLCli.UsageHint, "error: disk full"])
  })

  it("report: a usage error → 2 with the hint; an Error → 1; a non-Error value is wrapped (1, never usage)", () => {
    const { context } = createTestContext()
    expect(QLCli.report(context, new QLUsageError("bad flag"))).toBe(QLExitCode.usage)
    expect(QLCli.report(context, new Error("io"))).toBe(QLExitCode.failure)
    expect(context.exitCode).toBe(QLExitCode.failure)
    expect(QLCli.report(context, "a string")).toBe(QLExitCode.failure)
    const [usage, hint, io, wrapped] = logs.stderr()
    expect([usage, hint, io]).toEqual(["error: bad flag", QLCli.UsageHint, "error: io"])
    expect(wrapped).toContain(QLCli.NonErrorThrownMessage)
    expect(wrapped).toContain("a string")
  })

  it("completeParse absorbs a printed usage error, prints an unprinted one, and maps other errors to failure", async () => {
    const { context } = createTestContext()
    await QLCli.completeParse(context, () => Promise.reject(new QLUsageError("check failed")))
    expect(context.exitCode).toBe(QLExitCode.usage)
    expect(logs.stderr()).toEqual(["error: check failed", QLCli.UsageHint])
    await QLCli.completeParse(context, () => {
      throw new Error("boom")
    })
    expect(context.exitCode).toBe(QLExitCode.failure)
    const unprinted = createTestContext().context
    await QLCli.completeParse(unprinted, () => Promise.reject(new QLUsageError("late check")))
    expect(unprinted.exitCode).toBe(QLExitCode.usage)
    expect(logs.stderr().slice(-2)).toEqual(["error: late check", QLCli.UsageHint])
  })

  it("runInterruptibly reports SIGINT and removes its listener", async () => {
    const before = process.listenerCount(ProcessSignalName.SIGINT),
      interrupted = await QLCli.runInterruptibly(
        signal =>
          new Promise<string>(resolve => {
            signal.addEventListener("abort", () => resolve("aborted"))
            process.emit(ProcessSignalName.SIGINT)
          })
      ),
      quiet = await QLCli.runInterruptibly(async () => "done")
    expect(interrupted).toEqual({ value: "aborted", interrupted: true })
    expect(quiet).toEqual({ value: "done", interrupted: false })
    expect(process.listenerCount(ProcessSignalName.SIGINT)).toBe(before)
  })
})
