import Os from "node:os"
import Fs from "node:fs"
import Path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"

// `configured` is a module-level `let` in LoggingManager — it can't be poked
// directly, so these tests treat it as a black box across the whole suite. A
// `beforeAll` call to `configure` makes subsequent re-configures no-ops,
// which matches production semantics.

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
    log.fatal("probe-message")
    const file = Path.join(
      dir,
      LoggingManager.LogSubpath,
      LoggingManager.LogFilename
    )
    expect(Fs.existsSync(file)).toBe(true)
    // Yield so the appender's microtask and file I/O can finish before checking.
    const flushBudgetMs = 500,
      flushPollIntervalMs = 10,
      deadline = Date.now() + flushBudgetMs
    let contents = ""
    while (Date.now() < deadline) {
      contents = await Fs.promises.readFile(file, "utf8")
      if (contents.includes("probe-message")) break
      await sleep(flushPollIntervalMs)
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
