import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { configureStore } from "@reduxjs/toolkit"
import Bluebird from "bluebird"
import { Level, getLoggingManager, type LevelKind } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import {
  ReduxFileLogger,
  createReduxFileLogger
} from "@wireio/debugging-client-tool-tui/store/middleware/createReduxFileLogger.js"

const tmpRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), "redux-fl-")),
  logFile = Path.join(tmpRoot, "tui.log")

beforeAll(() => {
  // Configure once — `LoggingManager.configure` is idempotent. Per-test level
  // changes go through `setRootLevel` below.
  LoggingManager.configure({ filename: logFile, level: Level.info })
})

/**
 * Dynamically swap the logger's root level. The shared LoggingManager
 * singleton survives across tests; configure() can't be repeated, so we
 * mutate via setRootLevel directly.
 */
function setLevel(level: LevelKind): void {
  getLoggingManager().setRootLevel(level)
}

/** Single-action store with the file-logger middleware installed. */
function makeStore() {
  return configureStore({
    reducer: {
      x: (state: number = 0, action: { type: string }) =>
        action.type === "x/inc" ? state + 1 : state
    },
    middleware: getDefault => getDefault().concat(createReduxFileLogger())
  })
}

/**
 * Poll the shared log file for any line whose `category` matches the redux
 * logger AND whose body contains `actionType`. Returns the matching lines
 * (≥0). Polls because `FileAppender` flushes asynchronously.
 */
async function awaitReduxLines(actionType: string): Promise<string[]> {
  const deadline = Date.now() + 500,
    matches = (line: string): boolean =>
      line.includes(`"category":"${ReduxFileLogger.Category}"`) &&
      line.includes(actionType),
    poll = async (): Promise<string[]> => {
      const content = Fs.existsSync(logFile)
        ? Fs.readFileSync(logFile, "utf-8")
        : ""
      const found = content.split(/\r?\n/).filter(matches)
      if (found.length > 0) return found
      if (Date.now() > deadline) return []
      await Bluebird.delay(20)
      return poll()
    }
  return poll()
}

describe("ReduxFileLogger.Category", () => {
  it("matches the documented `tui:redux` namespace", () => {
    expect(ReduxFileLogger.Category).toBe("tui:redux")
  })
})

describe("createReduxFileLogger", () => {
  it("returns a function (a Redux middleware)", () => {
    expect(typeof createReduxFileLogger()).toBe("function")
  })

  it("emits redux-logger output to the file logger when level is debug", async () => {
    setLevel(Level.debug)
    const store = makeStore()
    store.dispatch({ type: "x/inc-debug" })
    const lines = await awaitReduxLines("x/inc-debug")
    expect(lines.length).toBeGreaterThan(0)
  })

  it("stays silent when level is info — predicate gates the middleware off", async () => {
    setLevel(Level.info)
    const store = makeStore()
    store.dispatch({ type: "x/inc-silent" })
    const lines = await awaitReduxLines("x/inc-silent")
    expect(lines).toEqual([])
  })

  it("re-activates when level is bumped back to debug", async () => {
    setLevel(Level.info)
    const store = makeStore()
    store.dispatch({ type: "x/inc-still-info" })
    const beforeBump = await awaitReduxLines("x/inc-still-info")
    expect(beforeBump).toEqual([])

    setLevel(Level.debug)
    store.dispatch({ type: "x/inc-after-bump" })
    const afterBump = await awaitReduxLines("x/inc-after-bump")
    expect(afterBump.length).toBeGreaterThan(0)
  })
})
