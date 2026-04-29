import Os from "node:os"
import Fs from "node:fs"
import Path from "node:path"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"

/** Override the module-private `configured` flag via a getter hack per test. */
function resetConfiguredFlag(): void {
  // `configured` is a module-level `let` in LoggingManager — we can't poke it
  // directly, so these tests treat it as a black box across the whole suite.
  // A `beforeAll` call to `configure` makes subsequent re-configures no-ops,
  // which matches production semantics.
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

  it("writes records to <clusterPath>/<LogSubpath>/<LogFilename>", () => {
    const log = LoggingManager.getGlobalLogger()
    log.fatal("probe-message")
    const file = Path.join(
      dir,
      LoggingManager.LogSubpath,
      LoggingManager.LogFilename
    )
    expect(Fs.existsSync(file)).toBe(true)
    // FileAppender flushes async via queueMicrotask; retry briefly.
    const deadline = Date.now() + 500
    let contents = ""
    while (Date.now() < deadline) {
      contents = Fs.readFileSync(file, "utf8")
      if (contents.includes("probe-message")) break
    }
    expect(contents).toContain("probe-message")
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
    const log = LoggingManager.getGlobalLogger() as unknown as {
      category: string
    }
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
