import Path from "node:path"

import { match, P } from "ts-pattern"

import { app, BrowserWindow, ipcMain, session } from "electron"
import { QLBrand } from "@wireio/ql-shared"
import { QLPaths, QLPlatform, type FileLoggingInstallation } from "@wireio/ql-shared/node"
import type { LogRecord } from "@wireio/shared"
import { getLogger, NestedError } from "@wireio/shared"
import type { FileAppender } from "@wireio/shared/node"

import { AppAction, IPCEventChannel, ThemeSource, type StoreKind } from "../common/index.js"
import { AppPaths } from "./AppPaths.js"
import {
  createContextMenuHandlers,
  createDialogHandlers,
  createExportHandlers,
  createStoreHandlers,
  createThemeHandlers,
  LogHandlers,
  QueryPortHandlers,
  registerIPCHandlers
} from "./ipc/index.js"
import { MainLogging } from "./logging/index.js"
import { ApplicationMenu } from "./menu/index.js"
import { QueryHostLauncher } from "./query/index.js"
import { ContentSecurityPolicy, RendererTrust } from "./security/index.js"
import { StoreService } from "./services/index.js"
import { NativeThemeController } from "./theme/index.js"
import { WindowManager, WindowStateStore } from "./windows/index.js"

const log = getLogger(__filename)

/** The services main runs once the app is ready. */
interface AppServices {
  appPaths: AppPaths
  logging: FileLoggingInstallation
  rendererLog: FileAppender<LogRecord>
  theme: NativeThemeController
  stores: StoreService
  launcher: QueryHostLauncher
  windows: WindowManager
}

/**
 * The native shell's lifecycle: single-instance lock (a second launch focuses the
 * existing window), boot sequence on `ready` (file logging → CSP → appearance →
 * stores → query host → IPC → menu → window), macOS keep-alive on
 * `window-all-closed`, and `before-quit` disposal of the query host, the store
 * watchers and the log files.
 */
export class AppLifecycle {
  private services: AppServices = null

  /**
   * @param appPath - Directory of the bundled `main.js`.
   */
  constructor(readonly appPath: string) {}

  /** Configure paths, take the single-instance lock and boot on `ready`. */
  start(): void {
    AppLifecycle.configurePaths()
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }
    app.on("second-instance", () => this.services?.windows.focusOrCreate())
    app.on("window-all-closed", () => {
      if (process.platform !== QLPlatform.darwin) app.quit()
    })
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) this.services?.windows.createWorkbench()
    })
    app.on("before-quit", () => this.dispose())
    app
      .whenReady()
      .then(() => this.boot())
      .catch(error => {
        log.error(`boot failed: ${NestedError.toError(error).message}`, error)
        app.exit(AppLifecycle.BootFailureExitCode)
      })
  }

  /** The boot sequence (runs once, on `ready`). */
  private boot(): void {
    const logsPath = app.getPath("logs"),
      logging = MainLogging.install(logsPath)
    ContentSecurityPolicy.install(session.defaultSession)
    const appPaths = AppPaths.resolve(this.appPath),
      trust = new RendererTrust(appPaths.rendererURL),
      userDataPath = app.getPath("userData"),
      rendererLog = MainLogging.createFileAppender(logsPath, MainLogging.RendererLogFilename),
      theme = new NativeThemeController(userDataPath),
      stores = new StoreService(),
      launcher = new QueryHostLauncher({ hostModuleFile: appPaths.hostModuleFile, logsPath }),
      windows = new WindowManager({ appPaths, trust, stateStore: new WindowStateStore(userDataPath), launcher })
    this.services = { appPaths, logging, rendererLog, theme, stores, launcher, windows }
    theme.restore()
    stores.watch(kind => AppLifecycle.broadcastStoreChanged(kind))
    launcher.start()
    registerIPCHandlers(
      ipcMain,
      {
        ...createStoreHandlers(stores),
        ...createExportHandlers(),
        ...createDialogHandlers(),
        ...createContextMenuHandlers(),
        ...createThemeHandlers(theme, () => this.installMenu())
      },
      trust
    )
    LogHandlers.register(ipcMain, rendererLog, logging.level, trust)
    QueryPortHandlers.register(ipcMain, launcher, trust)
    this.installMenu()
    app.setAboutPanelOptions({ applicationName: QLBrand.ProductName, iconPath: appPaths.iconFile })
    if (process.platform === QLPlatform.darwin && !app.isPackaged) app.dock?.setIcon(appPaths.iconFile)
    windows.createWorkbench()
    log.info(`${QLBrand.ProductName} ready (logs: ${logsPath})`)
  }

  /** (Re)install the application menu (appearance radios follow the active source). */
  private installMenu(): void {
    ApplicationMenu.install({
      platform: process.platform,
      themeSource: this.services.theme.source,
      dispatch: action => this.dispatch(action)
    })
  }

  /**
   * Route a menu action: appearance is main's; everything else goes to the focused window.
   *
   * @param action - The chosen action.
   */
  private dispatch(action: AppAction): void {
    match(action)
      .with(P.union(AppAction.appearanceSystem, AppAction.appearanceLight, AppAction.appearanceDark), () => {
        this.services.theme.set(AppLifecycle.themeSourceOf(action))
        this.installMenu()
      })
      .otherwise(() => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        window?.webContents.send(IPCEventChannel.menuAction, action)
      })
  }

  /** `before-quit` (once; later calls are no-ops): dispose the query host, stop watching stores, then flush and close both log files. */
  private dispose(): void {
    if (this.services == null) return
    const { launcher, stores, rendererLog, logging } = this.services
    this.services = null
    launcher.dispose()
    stores.close()
    rendererLog
      .close()
      .then(() => logging.restore())
      .catch(error => log.error(`closing the log files failed: ${NestedError.toError(error).message}`, error))
  }
}

/** Lifecycle constants + helpers. */
export namespace AppLifecycle {
  /** Exit code when the boot sequence throws. */
  export const BootFailureExitCode = 1

  /**
   * Apply `AppPaths.UserDataEnvironmentVariable` (before `ready`, as Electron
   * requires); the logs move to its `logs` subdirectory (`QLPaths.LogsSubpath`, as for `wql`).
   *
   * @param environment - Process environment.
   */
  export function configurePaths(environment: NodeJS.ProcessEnv = process.env): void {
    const userDataPath = environment[AppPaths.UserDataEnvironmentVariable]
    if (userDataPath == null) return
    app.setPath("userData", userDataPath)
    app.setAppLogsPath(Path.join(userDataPath, QLPaths.LogsSubpath))
  }

  /**
   * The appearance an appearance action selects.
   *
   * @param action - appearanceSystem / appearanceLight / appearanceDark.
   * @returns The source.
   */
  export function themeSourceOf(action: AppAction): ThemeSource {
    return match(action)
      .with(AppAction.appearanceLight, () => ThemeSource.light)
      .with(AppAction.appearanceDark, () => ThemeSource.dark)
      .otherwise(() => ThemeSource.system)
  }

  /**
   * Tell every window a store changed on disk.
   *
   * @param kind - Which store.
   */
  export function broadcastStoreChanged(kind: StoreKind): void {
    BrowserWindow.getAllWindows().forEach(window => window.webContents.send(IPCEventChannel.storeChanged, kind))
  }
}
