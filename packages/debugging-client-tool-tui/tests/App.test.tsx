import React from "react"
import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { App } from "@wireio/debugging-client-tool-tui/App.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "app-test-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

describe("App namespace", () => {
  it("exposes ReadyStatus — the mount-time status string", () => {
    expect(App.ReadyStatus).toBe("ready")
  })

  it("does NOT expose legacy keybinding constants — hotkeys live in useMultiKeyTrigger + router", () => {
    expect((App as any).QuitKey).toBeUndefined()
    expect((App as any).CycleFeatureKey).toBeUndefined()
  })
})

describe("App component factory", () => {
  it("is a React function component", () => {
    expect(typeof App).toBe("function")
  })
})
