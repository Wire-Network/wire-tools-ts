import Fs from "node:fs"
import Path from "node:path"

import { getLogger, getLoggingManager, Level } from "@wireio/shared"
import { FileLogging } from "@wireio/ql-shared/node"

import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

const log = getLogger(__filename)

describe("FileLogging", () => {
  const directory = useTemporaryDirectory("ql-file-logging-")

  it("reads the level LOG_LEVEL names (case-insensitive); anything else is the default", () => {
    expect(FileLogging.levelOf({ [FileLogging.LevelEnvironmentVariable]: "debug" })).toBe(Level.debug)
    expect(FileLogging.levelOf({ [FileLogging.LevelEnvironmentVariable]: "WARN" })).toBe(Level.warn)
    expect(FileLogging.levelOf({ [FileLogging.LevelEnvironmentVariable]: "loud" })).toBe(FileLogging.DefaultLevel)
    expect(FileLogging.levelOf({})).toBe(Level.info)
  })

  it("routes every record to the file until restore, which puts the sinks back and flushes the file", async () => {
    const manager = getLoggingManager(),
      before = [...manager.appenders],
      beforeLevel = manager.rootLevel,
      logsPath = Path.join(directory(), "nested", "logs"),
      installation = FileLogging.install({
        logsPath,
        filename: "file-logging.log",
        environment: { [FileLogging.LevelEnvironmentVariable]: "debug" }
      })
    expect(installation.file).toBe(Path.join(logsPath, "file-logging.log"))
    expect(installation.level).toBe(Level.debug)
    expect(manager.appenders).toEqual([installation.appender])
    log.debug("routed to the file")
    await installation.restore()
    expect(manager.appenders).toEqual(before)
    expect(manager.rootLevel).toBe(beforeLevel)
    expect(Fs.readFileSync(installation.file, "utf8")).toContain("routed to the file")
  })

  it("an explicit level wins over LOG_LEVEL, and restore is idempotent", async () => {
    const installation = FileLogging.install({
      logsPath: directory(),
      filename: "explicit.log",
      level: Level.warn,
      environment: { [FileLogging.LevelEnvironmentVariable]: "trace" }
    })
    expect(getLoggingManager().rootLevel).toBe(Level.warn)
    const first = installation.restore()
    expect(installation.restore()).toBe(first)
    await first
    expect(getLoggingManager().appenders).not.toContain(installation.appender)
  })
})
