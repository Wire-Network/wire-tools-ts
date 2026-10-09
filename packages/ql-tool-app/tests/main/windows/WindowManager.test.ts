import { getLoggingManager, type LogRecord } from "@wireio/shared"

import type { AppPaths } from "@wireio/ql-tool-app/main"
import type { QueryHostLauncher } from "@wireio/ql-tool-app/main/query"
import { RendererTrust } from "@wireio/ql-tool-app/main/security"
import { WindowManager, WindowRole, WindowStateStore } from "@wireio/ql-tool-app/main/windows"

import { BrowserWindow } from "../../__mocks__/electron.js"
import { RendererFixtures } from "../../common/RendererFixtures.js"
import { TempDirectory } from "../../common/TempDirectory.js"

/** Fixture bundle paths. */
const appPaths: AppPaths = {
  preloadFile: "/app/preload.js",
  hostModuleFile: "/app/query-host.js",
  rendererURL: RendererFixtures.FileURL,
  iconFile: "/app/assets/icon-512.png"
}

/** A manager with the collaborators a test inspects. */
interface ManagerFixture {
  manager: WindowManager
  stateStore: WindowStateStore
  launcher: QueryHostLauncher
}

/**
 * A manager over a temp state store.
 *
 * @returns The manager, its store and launcher.
 */
function newManager(): ManagerFixture {
  const stateStore = new WindowStateStore(TempDirectory.create()),
    launcher = { windowClosed: jest.fn() } as unknown as QueryHostLauncher
  return {
    manager: new WindowManager({ appPaths, trust: new RendererTrust(appPaths.rendererURL), stateStore, launcher }),
    stateStore,
    launcher
  }
}

beforeEach(() => {
  BrowserWindow.instances.length = 0
})

describe("WindowManager", () => {
  it("creates the workbench with the standard secure webPreferences, icon and preload", () => {
    const { manager } = newManager(),
      window = manager.createWorkbench() as unknown as BrowserWindow
    expect(window.options).toMatchObject({
      icon: appPaths.iconFile,
      width: WindowStateStore.DefaultWidth,
      height: WindowStateStore.DefaultHeight,
      webPreferences: { preload: appPaths.preloadFile, contextIsolation: true, nodeIntegration: false }
    })
    expect((window.options.webPreferences as Record<string, unknown>).sandbox).toBeUndefined()
    expect(window.loadURL).toHaveBeenCalledWith(appPaths.rendererURL)
  })

  it("restores saved bounds + maximized and persists them on close; closed detaches the port", () => {
    const { manager, stateStore, launcher } = newManager(),
      saved = { bounds: { x: 50, y: 60, width: 900, height: 700 }, maximized: true }
    stateStore.write(WindowRole.workbench, saved)
    const window = manager.createWorkbench() as unknown as BrowserWindow
    expect(window.options).toMatchObject(saved.bounds)
    expect(window.maximize).toHaveBeenCalled()
    window.bounds = { x: 1, y: 2, width: 640, height: 480 }
    window.emit("close")
    expect(stateStore.read(WindowRole.workbench)).toEqual({ bounds: window.bounds, maximized: true })
    window.emit("closed")
    expect(launcher.windowClosed).toHaveBeenCalledWith(window.webContents.id)
  })

  it("off-screen saved bounds fall back to the default size", () => {
    const { manager, stateStore } = newManager()
    stateStore.write(WindowRole.workbench, { bounds: { x: 9_000, y: 9_000, width: 900, height: 700 }, maximized: false })
    const window = manager.createWorkbench() as unknown as BrowserWindow
    expect(window.options).toMatchObject({ width: WindowStateStore.DefaultWidth, height: WindowStateStore.DefaultHeight })
    expect(window.options.x).toBeUndefined()
  })

  it("focusOrCreate focuses (restoring a minimized window) or opens one", () => {
    const { manager } = newManager()
    manager.focusOrCreate()
    expect(BrowserWindow.instances).toHaveLength(1)
    const [window] = BrowserWindow.instances
    window.isMinimized.mockReturnValueOnce(true)
    manager.focusOrCreate()
    expect(window.restore).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
    expect(BrowserWindow.instances).toHaveLength(1)
  })

  it("denies new windows and blocks navigation away from the renderer", () => {
    const { manager } = newManager(),
      window = manager.createWorkbench() as unknown as BrowserWindow,
      [handler] = window.webContents.setWindowOpenHandler.mock.calls[0]
    expect(handler({ url: "https://example.com/" })).toEqual(WindowManager.DenyWindowOpen)
    const away = { url: "https://example.com/", preventDefault: jest.fn() },
      reload = { url: appPaths.rendererURL, preventDefault: jest.fn() }
    window.webContents.emit("will-navigate", away)
    window.webContents.emit("will-navigate", reload)
    expect(away.preventDefault).toHaveBeenCalled()
    expect(reload.preventDefault).not.toHaveBeenCalled()
  })

  it("a rejected renderer load is logged with its error, never left unhandled", async () => {
    const { manager } = newManager(),
      logging = getLoggingManager(),
      previous = [...logging.appenders],
      records: LogRecord[] = []
    logging.setAppenders({ append: (record: LogRecord) => records.push(record) })
    try {
      BrowserWindow.loadURLResult.mockRejectedValueOnce(new Error("ERR_FILE_NOT_FOUND"))
      manager.createWorkbench()
      await new Promise(resolve => setImmediate(resolve))
      const failure = records.find(record => String(record.message).startsWith(`loading ${appPaths.rendererURL}`))
      expect(failure?.message).toContain("ERR_FILE_NOT_FOUND")
      expect(failure?.args[0]).toBeInstanceOf(Error)
    } finally {
      logging.setAppenders(previous)
    }
  })
})
