import SourceMapSupport from "source-map-support"

import { getLoggingManager } from "@wireio/shared"

import { executeCommandLine, main } from "@wireio/ql-tool-cli/cli/main.js"
import { QLExitCode } from "@wireio/ql-tool-cli/cli/index.js"
import { StdStreamAppender } from "@wireio/ql-tool-cli/logger.js"

import { captureLogs } from "../common/logCapture.js"
import { createTestContext } from "../common/testContext.js"

describe("cli main", () => {
  afterEach(() => {
    process.exitCode = 0
  })

  it("executeCommandLine runs a command and applies the run's exit code to the process", async () => {
    const logs = captureLogs()
    try {
      await executeCommandLine(["profiles", "list"], createTestContext().context)
      expect(process.exitCode).toBe(QLExitCode.success)
      await executeCommandLine(["--bogus"], createTestContext().context)
      expect(process.exitCode).toBe(QLExitCode.usage)
      expect(logs.stderr().length).toBeGreaterThan(0)
    } finally {
      logs.restore()
    }
  })

  it("main installs source maps and the routing appender FIRST, then runs the command line", async () => {
    const manager = getLoggingManager(),
      previous = [...manager.appenders],
      install = jest.spyOn(SourceMapSupport, "install").mockImplementation(() => undefined),
      append = jest.spyOn(StdStreamAppender.prototype, "append").mockImplementation(() => undefined)
    try {
      await main(["--bogus"], createTestContext().context)
      expect(install).toHaveBeenCalledTimes(1)
      expect(manager.appenders).toHaveLength(1)
      expect(manager.appenders[0]).toBeInstanceOf(StdStreamAppender)
      expect(process.exitCode).toBe(QLExitCode.usage)
      expect(append).toHaveBeenCalled()
    } finally {
      install.mockRestore()
      append.mockRestore()
      manager.setAppenders(...previous)
    }
  })
})
