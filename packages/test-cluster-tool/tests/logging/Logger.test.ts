import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { getLoggingManager, Level } from "@wireio/shared"
import { configureLogging, getLogger } from "@wireio/test-cluster-tool/logging"

describe("Logger", () => {
  describe("getLogger", () => {
    it("returns a logger exposing the standard level methods", () => {
      const log = getLogger("test.category")
      expect(typeof log.info).toBe("function")
      expect(typeof log.warn).toBe("function")
      expect(typeof log.error).toBe("function")
      expect(typeof log.debug).toBe("function")
    })
  })

  describe("configureLogging", () => {
    let dir: string
    beforeEach(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "logger-"))
    })
    afterEach(() => {
      // Drop the appenders (releasing the file-stream reference) before cleanup.
      getLoggingManager().setAppenders([])
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("sets the root level to the more verbose of console/file and installs two appenders", () => {
      configureLogging({
        consoleLevel: Level.warn,
        fileLevel: Level.debug,
        runLogFile: Path.join(dir, "run.jsonl")
      })
      const manager = getLoggingManager()
      // debug is more verbose (lower threshold) than warn
      expect(manager.rootLevel).toBe(Level.debug)
      expect(manager.appenders.length).toBe(2)
    })

    it("defaults console=info and file=debug when omitted", () => {
      configureLogging({ runLogFile: Path.join(dir, "run2.jsonl") })
      expect(getLoggingManager().rootLevel).toBe(Level.debug)
    })
  })
})
