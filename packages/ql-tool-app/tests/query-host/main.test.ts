import { EventEmitter } from "node:events"
import Fs from "node:fs"
import Path from "node:path"

import type { ParentPort } from "electron"
import { FileLogging } from "@wireio/ql-shared/node"
import { getLoggingManager, type LogRecord } from "@wireio/shared"
import type { FileAppender } from "@wireio/shared/node"

import { QueryHostArguments } from "@wireio/ql-tool-app/common"
import { QueryHostProcess, startQueryHost } from "@wireio/ql-tool-app/query-host"

import { TempDirectory } from "../common/TempDirectory.js"

describe("query-host main", () => {
  it("requiring the module outside a utility process starts nothing", () => {
    expect(process.parentPort).toBeUndefined()
    const parentPort = new EventEmitter()
    expect(parentPort.listenerCount("message")).toBe(0)
  })

  it("logsPathOf reads the flag's value and is undefined without it", () => {
    expect(QueryHostProcess.logsPathOf(["node", "host.js", QueryHostArguments.LogsPathFlag, "/logs"])).toBe("/logs")
    expect(QueryHostProcess.logsPathOf(["node", "host.js"])).toBeUndefined()
  })

  it("startQueryHost installs file logging under the logs path and listens on parentPort", async () => {
    const manager = getLoggingManager(),
      previous = [...manager.appenders],
      logsPath = Path.join(TempDirectory.create(), "logs"),
      parentPort = new EventEmitter(),
      host = startQueryHost(parentPort as unknown as ParentPort, [QueryHostArguments.LogsPathFlag, logsPath])
    expect(Fs.existsSync(logsPath)).toBe(true)
    expect(parentPort.listenerCount("message")).toBe(1)
    expect(host.attachedWindowIds).toEqual([])
    await (manager.appenders[0] as FileAppender<LogRecord>).close()
    manager.setAppenders(previous)
  })

  it("installFileLogging writes query-host.log at LOG_LEVEL; restore closes it", async () => {
    const logsPath = TempDirectory.create(),
      previous = [...getLoggingManager().appenders],
      installation = QueryHostProcess.installFileLogging(logsPath)
    expect(installation.file).toBe(Path.join(logsPath, QueryHostProcess.LogFilename))
    expect(installation.level).toBe(FileLogging.levelOf())
    await installation.restore()
    expect(getLoggingManager().appenders).toEqual(previous)
  })
})
