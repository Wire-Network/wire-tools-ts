import { BrowserWindow, nativeTheme, screen, type WebContents, type WindowOpenHandlerResponse } from "electron"
import { QLBrand } from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import type { AppPaths } from "../AppPaths.js"
import type { QueryHostLauncher } from "../query/index.js"
import type { RendererTrust } from "../security/index.js"
import { WindowRole } from "./WindowRole.js"
import { WindowStateStore, type WindowState } from "./WindowStateStore.js"

const log = getLogger(__filename)

/** What the window manager composes. */
export interface WindowManagerOptions {
  /** Bundle file locations (preload, renderer page, icon). */
  appPaths: AppPaths
  /** The pages a window may navigate to (the renderer's own). */
  trust: RendererTrust
  /** Persisted bounds/maximized state. */
  stateStore: WindowStateStore
  /** Told when a window goes away (its query port is detached). */
  launcher: QueryHostLauncher
}

/**
 * Creates the workbench window with Electron's standard defaults — context
 * isolation, no Node integration, sandbox and webSecurity left at their `true`
 * defaults — a typed preload, the app icon and restored bounds, and the
 * security checklist's navigation guards: no new windows, and navigation only
 * within the renderer's own origin.
 */
export class WindowManager {
  /**
   * @param options - Paths, trust, state store and launcher.
   */
  constructor(readonly options: WindowManagerOptions) {}

  /** The open workbench windows. */
  get workbenchWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows()
  }

  /**
   * Open a workbench window (bounds restored, clamped onto a visible display).
   *
   * @returns The window.
   */
  createWorkbench(): BrowserWindow {
    const { appPaths, trust, stateStore, launcher } = this.options,
      saved = stateStore.read(WindowRole.workbench),
      bounds = WindowStateStore.visibleBounds(
        saved.bounds,
        screen.getAllDisplays().map(display => display.workArea)
      ),
      window = new BrowserWindow({
        ...(bounds ?? { width: WindowStateStore.DefaultWidth, height: WindowStateStore.DefaultHeight }),
        title: QLBrand.ProductName,
        icon: appPaths.iconFile,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors
          ? WindowManager.DarkBackground
          : WindowManager.LightBackground,
        webPreferences: {
          preload: appPaths.preloadFile,
          contextIsolation: true,
          nodeIntegration: false
        }
      }),
      webContentsId = window.webContents.id
    if (saved.maximized) window.maximize()
    window.once("ready-to-show", () => window.show())
    window.on("close", () => stateStore.write(WindowRole.workbench, WindowManager.stateOf(window)))
    window.on("closed", () => launcher.windowClosed(webContentsId))
    window.webContents.on("render-process-gone", (_event, details) =>
      log.error(`renderer of window ${webContentsId} gone: ${details.reason}`)
    )
    WindowManager.guardNavigation(window.webContents, trust)
    window.loadURL(appPaths.rendererURL).catch(error =>
      log.error(`loading ${appPaths.rendererURL} into window ${webContentsId} failed: ${NestedError.toError(error).message}`, error)
    )
    log.info(`opened workbench window ${webContentsId} → ${appPaths.rendererURL}`)
    return window
  }

  /** Focus the first window (second-instance launch), or open one. */
  focusOrCreate(): void {
    const [existing] = this.workbenchWindows
    if (existing == null) {
      this.createWorkbench()
      return
    }
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
}

/** Window constants + helpers. */
export namespace WindowManager {
  /** Pre-paint background in light mode (matches the MUI light paper). */
  export const LightBackground = "#ffffff"
  /** Pre-paint background in dark mode (matches the MUI dark default). */
  export const DarkBackground = "#121212"
  /** The answer to every `window.open` / target=_blank: no new windows. */
  export const DenyWindowOpen: WindowOpenHandlerResponse = { action: "deny" }

  /**
   * Deny every new window and cancel (and log) any navigation away from the
   * renderer's origin.
   *
   * @param webContents - The window's contents.
   * @param trust - The renderer's own pages.
   */
  export function guardNavigation(webContents: WebContents, trust: RendererTrust): void {
    webContents.setWindowOpenHandler(() => DenyWindowOpen)
    webContents.on("will-navigate", event => {
      if (trust.isTrusted(event.url)) return
      event.preventDefault()
      log.warn(`blocked navigation of window ${webContents.id} to ${event.url}`)
    })
  }

  /**
   * The persistable state of a window.
   *
   * @param window - The window.
   * @returns Its normal bounds and maximized flag.
   */
  export function stateOf(window: BrowserWindow): WindowState {
    return { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
  }
}
