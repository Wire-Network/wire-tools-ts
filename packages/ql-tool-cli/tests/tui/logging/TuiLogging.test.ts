import Fs from "node:fs"
import Path from "node:path"

import { getLogger, getLoggingManager, Level } from "@wireio/shared"

import { TuiLogging } from "@wireio/ql-tool-cli/tui/index.js"

import { createTemporaryDirectory } from "../../common/temporaryDirectory.js"

const log = getLogger(__filename)

describe("TuiLogging", () => {
  it("installs the shared file sink (creating the directory) and restore awaits the file's close", async () => {
    const logsPath = Path.join(createTemporaryDirectory("wql-tui-log-"), "nested", "logs"),
      manager = getLoggingManager(),
      before = [...manager.appenders],
      installation = TuiLogging.install({ logsPath, level: Level.debug })
    expect(installation.file).toBe(Path.join(logsPath, TuiLogging.LogFilename))
    expect(Fs.existsSync(logsPath)).toBe(true)
    expect(manager.appenders).toEqual([installation.appender])
    expect(manager.rootLevel).toBe(Level.debug)
    expect(TuiLogging.install({ logsPath })).toBe(installation)
    log.info("into the file")
    await installation.restore()
    expect(Fs.readFileSync(installation.file, "utf8")).toContain("into the file")
    expect(manager.appenders).toEqual(before)
  })

  it("installs anew after a restore (the level then comes from LOG_LEVEL or the default)", async () => {
    const logsPath = createTemporaryDirectory("wql-tui-log-"),
      first = TuiLogging.install({ logsPath, level: Level.warn })
    await first.restore()
    const second = TuiLogging.install({ logsPath })
    expect(second).not.toBe(first)
    await second.restore()
    await second.restore()
  })
})
