import Path from "node:path"

import type { MenuItemConstructorOptions } from "electron"
import { QLPaths } from "@wireio/ql-shared/node"
import { getLoggingManager } from "@wireio/shared"

import { AppAction, IPCContract, IPCEventChannel, ThemeSource } from "@wireio/ql-tool-app/common"
import { AppLifecycle, AppPaths } from "@wireio/ql-tool-app/main"

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  utilityProcess,
  type FakeMenu
} from "../__mocks__/electron.js"
import { TempDirectory } from "../common/TempDirectory.js"

/** Fixture constants. */
namespace Fixture {
  export const AppPath = "/app"
}

/**
 * The listener the lifecycle registered for an app event.
 *
 * @param event - App event name.
 * @returns The listener.
 */
function appListener(event: string): (...args: unknown[]) => void {
  return app.on.mock.calls.find(([name]) => name === event)[1]
}

/** Let `whenReady().then(boot)` run. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * The application menu item labelled `label`.
 *
 * @param label - Item label.
 * @returns The item.
 */
function menuItem(label: string): MenuItemConstructorOptions {
  const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.flatMap(item => [item, ...flatten((item.submenu as MenuItemConstructorOptions[]) ?? [])]),
    installed: FakeMenu = Menu.setApplicationMenu.mock.calls.at(-1)[0]
  return flatten(installed.template as MenuItemConstructorOptions[]).find(item => item.label === label)
}

let userDataPath: string = null

beforeEach(() => {
  userDataPath = TempDirectory.create()
  process.env.XDG_CONFIG_HOME = Path.join(userDataPath, "config")
  process.env.XDG_STATE_HOME = Path.join(userDataPath, "state")
  app.getPath.mockImplementation((name: string) => Path.join(userDataPath, name))
  app.on.mockClear()
  app.quit.mockClear()
  app.whenReady.mockClear()
  app.requestSingleInstanceLock.mockReturnValue(true)
  ipcMain.handle.mockClear()
  BrowserWindow.instances.length = 0
  utilityProcess.forked.length = 0
})

// Every started lifecycle is disposed (query host killed, store watchers closed) so
// no fs.watch handle outlives its test.
afterEach(() =>
  app.on.mock.calls.filter(([name]) => name === "before-quit").forEach(([, listener]) => listener())
)

describe("AppLifecycle", () => {
  it("a second instance quits without booting", () => {
    app.requestSingleInstanceLock.mockReturnValue(false)
    new AppLifecycle(Fixture.AppPath).start()
    expect(app.quit).toHaveBeenCalled()
    expect(app.whenReady).not.toHaveBeenCalled()
  })

  it("boots: query host forked, every invoke and send channel handled, menu installed, one window opened", async () => {
    const lifecycle = new AppLifecycle(Fixture.AppPath)
    ipcMain.on.mockClear()
    lifecycle.start()
    await flush()
    expect(utilityProcess.forked).toHaveLength(1)
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel).sort()).toEqual([...IPCContract.InvokeChannels].sort())
    expect(ipcMain.on.mock.calls.map(([channel]) => channel).sort()).toEqual([...IPCContract.SendChannels].sort())
    expect(Menu.setApplicationMenu).toHaveBeenCalled()
    expect(BrowserWindow.instances).toHaveLength(1)
    expect(getLoggingManager().appenders).toHaveLength(1)
    appListener("before-quit")()
    expect(utilityProcess.forked[0].kill).toHaveBeenCalled()
    appListener("before-quit")()
    expect(utilityProcess.forked[0].kill).toHaveBeenCalledTimes(1)
  })

  it("a boot that throws is logged with its error and exits with BootFailureExitCode", async () => {
    app.exit.mockClear()
    app.getPath.mockImplementationOnce(() => {
      throw new Error("no logs path")
    })
    new AppLifecycle(Fixture.AppPath).start()
    await flush()
    expect(app.exit).toHaveBeenCalledWith(AppLifecycle.BootFailureExitCode)
  })

  it("second-instance focuses the existing window instead of opening another", async () => {
    new AppLifecycle(Fixture.AppPath).start()
    await flush()
    appListener("second-instance")()
    expect(BrowserWindow.instances).toHaveLength(1)
    expect(BrowserWindow.instances[0].focus).toHaveBeenCalled()
  })

  it("window-all-closed quits except on macOS", () => {
    new AppLifecycle(Fixture.AppPath).start()
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "darwin" })
    appListener("window-all-closed")()
    expect(app.quit).not.toHaveBeenCalled()
    Object.defineProperty(process, "platform", platform)
    appListener("window-all-closed")()
    expect(app.quit).toHaveBeenCalled()
  })

  it("menu actions go to the focused window; appearance actions are handled by main", async () => {
    new AppLifecycle(Fixture.AppPath).start()
    await flush()
    menuItem("Run").click(null, null, null)
    expect(BrowserWindow.instances[0].webContents.send).toHaveBeenCalledWith(IPCEventChannel.menuAction, AppAction.run)
    menuItem("Dark").click(null, null, null)
    expect(nativeTheme.themeSource).toBe(ThemeSource.dark)
    expect(BrowserWindow.instances[0].webContents.send).toHaveBeenCalledTimes(1)
  })

  it("configurePaths relocates userData + logs only when the variable is set", () => {
    app.setPath.mockClear()
    AppLifecycle.configurePaths({})
    expect(app.setPath).not.toHaveBeenCalled()
    AppLifecycle.configurePaths({ [AppPaths.UserDataEnvironmentVariable]: "/data/ql" })
    expect(app.setPath).toHaveBeenCalledWith("userData", "/data/ql")
    expect(app.setAppLogsPath).toHaveBeenCalledWith(Path.join("/data/ql", QLPaths.LogsSubpath))
  })

  it("themeSourceOf maps appearance actions and defaults to system", () => {
    expect(AppLifecycle.themeSourceOf(AppAction.appearanceLight)).toBe(ThemeSource.light)
    expect(AppLifecycle.themeSourceOf(AppAction.appearanceDark)).toBe(ThemeSource.dark)
    expect(AppLifecycle.themeSourceOf(AppAction.appearanceSystem)).toBe(ThemeSource.system)
    expect(AppLifecycle.themeSourceOf(AppAction.run)).toBe(ThemeSource.system)
  })
})
