import Fs from "node:fs"

import { WindowRole, WindowStateStore } from "@wireio/ql-tool-app/main/windows"

import { TempDirectory } from "../../common/TempDirectory.js"

/** A 1920×1080 primary display. */
const Primary = { x: 0, y: 0, width: 1920, height: 1080 }

describe("WindowStateStore", () => {
  it("persists and restores bounds + maximized per role", () => {
    const store = new WindowStateStore(TempDirectory.create()),
      state = { bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true }
    expect(store.read(WindowRole.workbench)).toEqual(WindowStateStore.defaultState())
    store.write(WindowRole.workbench, state)
    expect(new WindowStateStore(store.userDataPath).read(WindowRole.workbench)).toEqual(state)
  })

  it("a corrupt state file reads as the default and is replaced on write", () => {
    const store = new WindowStateStore(TempDirectory.create())
    Fs.writeFileSync(store.file, "{ not json")
    expect(store.read(WindowRole.workbench)).toEqual(WindowStateStore.defaultState())
    store.write(WindowRole.workbench, { bounds: null, maximized: false })
    expect(store.read(WindowRole.workbench)).toEqual({ bounds: null, maximized: false })
  })

  it("visibleBounds keeps on-screen bounds and clamps off-screen ones to null", () => {
    const onScreen = { x: 100, y: 100, width: 800, height: 600 }
    expect(WindowStateStore.visibleBounds(onScreen, [Primary])).toBe(onScreen)
    expect(WindowStateStore.visibleBounds({ x: 5_000, y: 5_000, width: 800, height: 600 }, [Primary])).toBeNull()
    expect(WindowStateStore.visibleBounds(null, [Primary])).toBeNull()
  })
})
