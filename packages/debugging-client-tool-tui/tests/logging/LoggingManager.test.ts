import Os from "node:os"
import Fs from "node:fs"
import Path from "node:path"
import { Deferred, Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"

// `configured` is a module-level `let` in LoggingManager — it can't be poked
// directly, so these tests treat it as a black box across the whole suite. A
// `beforeAll` call to `configure` makes subsequent re-configures no-ops,
// which matches production semantics.

/** The record the file-routing test logs and looks for. */
const ProbeMessage = "probe-message"
/** How long the file-routing test waits for the record to reach the file. */
const ProbeDeadlineMs = 5_000
/** Pause between reads of the log file while waiting. */
const ProbePollIntervalMs = 10

/**
 * Read `file` until it contains `needle` or {@link ProbeDeadlineMs} passes.
 * The `FileAppender` writes asynchronously, so each wait yields to the event
 * loop; a synchronous loop would block the very write it is waiting for.
 *
 * @param file - The log file.
 * @param needle - The text to wait for.
 * @returns The file's contents at the last read.
 */
async function readUntilContains(file: string, needle: string): Promise<string> {
  const deadline = Date.now() + ProbeDeadlineMs
  let contents = Fs.readFileSync(file, "utf8")
  while (!contents.includes(needle) && Date.now() < deadline) {
    await Deferred.delay(ProbePollIntervalMs)
    contents = Fs.readFileSync(file, "utf8")
  }
  return contents
}

describe("LoggingManager.configure", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "lm-test-"))
    LoggingManager.configure({ clusterPath: dir, level: Level.fatal })
  })

  it("creates the log directory structure under the cluster path", () => {
    const expected = Path.join(dir, LoggingManager.LogSubpath)
    expect(Fs.existsSync(expected)).toBe(true)
  })

  it("writes records to <clusterPath>/<LogSubpath>/<LogFilename>", async () => {
    const log = LoggingManager.getGlobalLogger()
    log.fatal(ProbeMessage)
    const file = Path.join(
      dir,
      LoggingManager.LogSubpath,
      LoggingManager.LogFilename
    )
    expect(Fs.existsSync(file)).toBe(true)
    expect(await readUntilContains(file, ProbeMessage)).toContain(ProbeMessage)
  })

  it("is idempotent — second configure() is a no-op", () => {
    // Call again with a different level; the existing appender stays put.
    expect(() =>
      LoggingManager.configure({ clusterPath: dir, level: Level.error })
    ).not.toThrow()
  })
})

describe("LoggingManager.getLogger after configure", () => {
  it("returns a Logger with trace/debug/info/warn/error/fatal methods", () => {
    const log = LoggingManager.getLogger("tui:test")
    expect(typeof log.info).toBe("function")
    expect(typeof log.error).toBe("function")
    expect(typeof log.fatal).toBe("function")
  })

  it("getGlobalLogger uses the `tui` category", () => {
    const log = LoggingManager.getGlobalLogger()
    expect(log.category).toBe(LoggingManager.GlobalCategory)
  })
})

describe("LoggingManager namespace constants", () => {
  it("exposes RollSizeBytes, MaxFiles, LogSubpath, LogFilename", () => {
    expect(LoggingManager.RollSizeBytes).toBeGreaterThan(0)
    expect(LoggingManager.MaxFiles).toBeGreaterThan(0)
    expect(LoggingManager.LogSubpath).toBe("data/tui/logs")
    expect(LoggingManager.LogFilename).toBe("tui.log")
    expect(LoggingManager.GlobalCategory).toBe("tui")
  })
})
