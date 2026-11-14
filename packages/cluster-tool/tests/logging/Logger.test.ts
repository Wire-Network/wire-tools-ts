import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ConsoleAppender, getLoggingManager, Level } from "@wireio/shared"
import {
  configureCommandLogging,
  configureLogging,
  getLogger,
  getStdoutLogger,
  StdoutAppender
} from "@wireio/cluster-tool/logging"

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

  describe("getStdoutLogger", () => {
    it("is categorized as the stdout data channel — the bare category, or stdout:<name>", () => {
      expect(getStdoutLogger().category).toBe(StdoutAppender.Category)
      expect(getStdoutLogger("listing").category).toBe(
        StdoutAppender.category("listing")
      )
      expect(StdoutAppender.isStdoutCategory(getStdoutLogger("listing").category)).toBe(
        true
      )
    })
  })

  describe("configureCommandLogging", () => {
    let stdoutAppend: jest.SpyInstance,
      consoleAppend: jest.SpyInstance,
      consoleError: jest.SpyInstance

    beforeEach(() => {
      // Each channel is observed here at ITS appender's `append`; the streams
      // those appenders reach are asserted under "configureCommandLogging —
      // the stream each channel reaches" below. `console.error`, the binding
      // every command diagnostic is written through, is additionally silenced
      // so the diagnostic text never reaches jest's console wrapper.
      stdoutAppend = jest
        .spyOn(StdoutAppender.prototype, "append")
        .mockImplementation(() => undefined)
      consoleAppend = jest.spyOn(ConsoleAppender.prototype, "append")
      consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    })

    afterEach(() => {
      getLoggingManager().setAppenders([])
      stdoutAppend.mockRestore()
      consoleAppend.mockRestore()
      consoleError.mockRestore()
    })

    /** The categories of every record the stdout appender was handed. */
    function stdoutAppendCategories(): string[] {
      return stdoutAppend.mock.calls.map(([record]) => record.category)
    }

    it("installs a level-gated console appender plus the raw stdout appender, at the given root level", () => {
      configureCommandLogging(Level.warn)
      const manager = getLoggingManager()
      expect(manager.rootLevel).toBe(Level.warn)
      expect(manager.appenders).toHaveLength(2)
      expect(manager.appenders[0]).toBeInstanceOf(ConsoleAppender)
      expect(manager.appenders[1]).toBeInstanceOf(StdoutAppender)
    })

    it("defaults the console level to info", () => {
      configureCommandLogging()
      expect(getLoggingManager().rootLevel).toBe(Level.info)
    })

    it("routes a stdout-logger record to the stdout appender exactly once — the console appender SKIPS the data channel", () => {
      configureCommandLogging()
      getStdoutLogger().info('{"listing":true}')
      expect(stdoutAppend).toHaveBeenCalledTimes(1)
      expect(stdoutAppend.mock.calls[0][0]).toMatchObject({
        category: StdoutAppender.Category,
        message: '{"listing":true}'
      })
      // No double print: the formatted console path never saw the data record.
      expect(consoleError).not.toHaveBeenCalled()
      expect(
        consoleAppend.mock.calls.filter(([record]) =>
          StdoutAppender.isStdoutCategory(record.category)
        )
      ).toHaveLength(0)
    })

    it("routes a sub-category stdout logger (stdout:<name>) the same way", () => {
      configureCommandLogging()
      getStdoutLogger("listing").info("row")
      expect(stdoutAppendCategories()).toEqual([StdoutAppender.category("listing")])
      expect(stdoutAppend.mock.calls[0][0]).toMatchObject({ message: "row" })
      expect(consoleError).not.toHaveBeenCalled()
    })

    it("routes a diagnostic record through the console appender — the stdout appender sees it but writes nothing for it", () => {
      configureCommandLogging()
      getLogger("command.diagnostics").info("resolving custody settings")
      expect(consoleAppend).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
      // Every appender receives every record; the stdout one ignores a non-stdout category.
      expect(
        stdoutAppendCategories().filter(StdoutAppender.isStdoutCategory)
      ).toEqual([])
    })

    it("the console appender gates on ITS level — a debug diagnostic is dropped at info", () => {
      configureCommandLogging(Level.info)
      getLogger("command.diagnostics").debug("too chatty")
      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe("configureCommandLogging — the stream each channel reaches", () => {
    let stdoutWrite: jest.SpyInstance,
      consoleError: jest.SpyInstance,
      consoleInfo: jest.SpyInstance,
      consoleLog: jest.SpyInstance,
      consoleDebug: jest.SpyInstance

    beforeEach(() => {
      // Observed at the STREAM, not at an appender: a caller capturing the
      // command's stdout (`create-batch-operator-keys > listing.json`) gets
      // every raw `process.stdout.write` plus every line written through a
      // console binding Node routes to stdout (`info` / `log` / `debug`).
      // Each spy is silenced so nothing reaches jest's own output.
      stdoutWrite = jest.spyOn(process.stdout, "write").mockReturnValue(true)
      consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
      consoleInfo = jest.spyOn(console, "info").mockImplementation(() => undefined)
      consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined)
      consoleDebug = jest.spyOn(console, "debug").mockImplementation(() => undefined)
    })

    afterEach(() => {
      getLoggingManager().setAppenders([])
      ;[stdoutWrite, consoleError, consoleInfo, consoleLog, consoleDebug].forEach(spy =>
        spy.mockRestore()
      )
    })

    /** Nothing reached stdout: no stdout-bound console binding, no raw stream write. */
    function expectNothingOnStdout(): void {
      expect(consoleInfo).not.toHaveBeenCalled()
      expect(consoleLog).not.toHaveBeenCalled()
      expect(consoleDebug).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    }

    it("writes an info diagnostic from a per-file logger to stderr (console.error), never to stdout", () => {
      configureCommandLogging()
      getLogger(__filename).info("created EM multi-Region key")
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("created EM multi-Region key")
      )
      expectNothingOnStdout()
    })

    it("writes a debug diagnostic to stderr as well once the console level admits it", () => {
      configureCommandLogging(Level.debug)
      getLogger(__filename).debug("resolving the key alias")
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("resolving the key alias")
      )
      expectNothingOnStdout()
    })

    it("writes a stdout data line raw to process.stdout, never to stderr", () => {
      configureCommandLogging()
      getStdoutLogger().info('{"listing":true}')
      expect(stdoutWrite).toHaveBeenCalledTimes(1)
      expect(stdoutWrite).toHaveBeenCalledWith('{"listing":true}\n')
      expect(consoleError).not.toHaveBeenCalled()
    })

    it("still gates on the console level — an info diagnostic at warn writes nothing", () => {
      configureCommandLogging(Level.warn)
      getLogger(__filename).info("below the console level")
      expect(consoleError).not.toHaveBeenCalled()
      expectNothingOnStdout()
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
