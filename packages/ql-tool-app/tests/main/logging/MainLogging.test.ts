import Fs from "node:fs"
import Path from "node:path"

import { FileLogging } from "@wireio/ql-shared/node"
import { getLoggingManager, Level } from "@wireio/shared"

import { MainLogging } from "@wireio/ql-tool-app/main/logging"

import { TempDirectory } from "../../common/TempDirectory.js"

describe("MainLogging", () => {
  it("createFileAppender creates the logs directory and targets <logs>/<file>", async () => {
    const logsPath = Path.join(TempDirectory.create(), "nested", "logs"),
      appender = MainLogging.createFileAppender(logsPath, MainLogging.RendererLogFilename)
    expect(Fs.statSync(logsPath).isDirectory()).toBe(true)
    await appender.close()
  })

  it("install routes main's loggers to main.log at LOG_LEVEL and restore puts the previous sink back", async () => {
    const manager = getLoggingManager(),
      previous = [...manager.appenders],
      logsPath = TempDirectory.create(),
      variable = process.env[FileLogging.LevelEnvironmentVariable]
    process.env[FileLogging.LevelEnvironmentVariable] = Level.debug
    try {
      const installation = MainLogging.install(logsPath)
      expect(installation.file).toBe(Path.join(logsPath, MainLogging.MainLogFilename))
      expect(installation.level).toBe(Level.debug)
      expect(manager.appenders).toEqual([installation.appender])
      await installation.restore()
      expect(manager.appenders).toEqual(previous)
    } finally {
      if (variable == null) delete process.env[FileLogging.LevelEnvironmentVariable]
      else process.env[FileLogging.LevelEnvironmentVariable] = variable
    }
  })
})
