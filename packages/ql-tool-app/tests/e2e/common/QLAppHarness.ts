import Fs from "node:fs"
import Path from "node:path"

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import type { WebPreferences } from "electron"
import { ConnectionProfileStore, QLPaths } from "@wireio/ql-shared/node"

import { IPCChannel, QLBridge, ThemeSource } from "@wireio/ql-tool-app/common"
import { AppPaths } from "@wireio/ql-tool-app/main"
import { QueryHostLauncher } from "@wireio/ql-tool-app/main/query"

import { TempDirectory } from "../../common/TempDirectory.js"
import { E2EPaths } from "./E2EPaths.js"
import { ElectronSandbox } from "./ElectronSandbox.js"

/** What one app launch is pointed at. */
export interface QLAppLaunchOptions {
  /** Isolated home for userData + logs + the shared wql stores (reused across relaunches). */
  rootPath: string
  /** Stub engine URL written into profiles.json as the default "stub" profile (omit for none). */
  endpoint?: string
  /** Packaged executable (default: the dev Electron running dist/app/main.js). */
  executablePath?: string
  /** Extra environment. */
  environment?: NodeJS.ProcessEnv
}

/**
 * Electron's `WebContents.getLastWebPreferences()`: present at runtime but not declared in
 * electron.d.ts. It returns the resolved preferences the window was created with, which is
 * the only main-side view of `sandbox` / `contextIsolation` / `nodeIntegration`.
 */
export interface LastWebPreferencesAccessor {
  /** The window's resolved web preferences. */
  getLastWebPreferences(): WebPreferences
}

/** A launched app with its first window and the console it produced. */
export interface QLAppSession {
  /** The Electron application. */
  app: ElectronApplication
  /** The workbench window. */
  page: Page
  /** Console lines of the renderer (CSP violations included). */
  console: string[]
  /** userData directory. */
  userDataPath: string
}

/** Launch / inspect helpers of the e2e suite. */
export namespace QLAppHarness {
  /** The webpack output (`dist/app`). */
  export const AppOutputPath = Path.join(E2EPaths.PackagePath, "dist", "app")
  /** The bundled main. */
  export const MainFile = Path.join(AppOutputPath, AppPaths.MainFilename)
  /** The stub profile name. */
  export const StubProfileName = "stub"
  /** The stub profile's owners. */
  export const StubOwners = ["sample"]
  /** The stub profile's transport ceiling (ms). */
  export const StubTransportTimeoutMs = 10_000
  /** userData under an isolated root. */
  export const UserDataSubpath = "user"
  /** XDG config home under an isolated root (QLPaths reads it: profiles.json, saved-queries.json). */
  export const ConfigSubpath = "config"
  /** XDG state home under an isolated root (QLPaths reads it: history.jsonl). */
  export const StateSubpath = "state"
  /** Environment variable the e2e globalSetup publishes the virtual display under. */
  export const DisplayEnvironmentVariable = "WIRE_QL_E2E_DISPLAY"
  /** CSP violation console signature. */
  export const CspViolationPattern = /Content Security Policy|Refused to (load|execute|apply|connect|create)/i

  /**
   * A new isolated root directory (a `TempDirectory`, removed by `TempDirectory.removeAll`).
   *
   * @returns The directory.
   */
  export function createRoot(): string {
    return TempDirectory.create()
  }

  /**
   * The app's environment for an isolated root: userData relocated (logs under it)
   * and the XDG homes `QLPaths` resolves profiles / saved queries / history from.
   *
   * @param rootPath - The isolated root.
   * @returns The variables.
   */
  export function isolatedEnvironment(rootPath: string): NodeJS.ProcessEnv {
    return {
      [AppPaths.UserDataEnvironmentVariable]: Path.join(rootPath, UserDataSubpath),
      XDG_CONFIG_HOME: Path.join(rootPath, ConfigSubpath),
      XDG_STATE_HOME: Path.join(rootPath, StateSubpath)
    }
  }

  /**
   * Write the default "stub" profile at `endpoint` through the app's own store
   * (`ConnectionProfileStore` at the `QLPaths` file the app will read).
   *
   * @param rootPath - The isolated root.
   * @param endpoint - Stub URL.
   */
  export function writeProfile(rootPath: string, endpoint: string): void {
    const store = new ConnectionProfileStore(QLPaths.profilesFile({ environment: isolatedEnvironment(rootPath) }))
    store.upsert({ name: StubProfileName, endpoint, transportTimeoutMs: StubTransportTimeoutMs, retries: 0, owners: StubOwners })
    store.setDefault(StubProfileName)
  }

  /**
   * Launch the app on the e2e display, isolated under `rootPath`. When anything
   * after the launch fails (no first window, a failed reload) the app is closed —
   * and its exit awaited — before the error propagates, so a failed launch never
   * leaves an Electron process tree behind for the spec's afterEach to miss.
   *
   * @param options - Root, endpoint, executable.
   * @returns The session.
   */
  export async function launch(options: QLAppLaunchOptions): Promise<QLAppSession> {
    const { rootPath, endpoint, executablePath, environment = {} } = options
    if (endpoint != null) writeProfile(rootPath, endpoint)
    const userDataPath = Path.join(rootPath, UserDataSubpath),
      electronBinary = executablePath ?? (require("electron") as unknown as string),
      app = await electron.launch({
        executablePath: electronBinary,
        // No media emulation: prefers-color-scheme must come from nativeTheme.
        colorScheme: null,
        args: [...(executablePath == null ? [MainFile] : []), ...ElectronSandbox.switches(electronBinary)],
        env: {
          ...process.env,
          DISPLAY: process.env[DisplayEnvironmentVariable] ?? process.env.DISPLAY,
          ...isolatedEnvironment(rootPath),
          ...environment
        }
      })
    try {
      const page = await app.firstWindow(),
        lines: string[] = []
      page.on("console", message => lines.push(`${message.type()}: ${message.text()}`))
      page.on("pageerror", error => lines.push(`pageerror: ${error.message}`))
      // Reload once with the listeners attached so load-time console output (CSP
      // reports included) is captured too.
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      return { app, page, console: lines, userDataPath }
    } catch (error) {
      await app.close()
      throw error
    }
  }

  /**
   * The console lines that are CSP violations.
   *
   * @param session - The session.
   * @returns The violations.
   */
  export function cspViolations(session: QLAppSession): string[] {
    return session.console.filter(line => CspViolationPattern.test(line))
  }

  /**
   * One log file's records.
   *
   * @param session - The session.
   * @param filename - `MainLogging.MainLogFilename` / `.RendererLogFilename` / `QueryHostProcess.LogFilename`.
   * @returns Parsed JSON lines.
   */
  export function logRecords(session: QLAppSession, filename: string): Array<Record<string, unknown>> {
    const file = Path.join(session.userDataPath, QLPaths.LogsSubpath, filename)
    return Fs.existsSync(file)
      ? Fs.readFileSync(file, "utf8")
          .split("\n")
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line))
      : []
  }

  /**
   * pid of the query-host utility process.
   *
   * @param session - The session.
   * @returns Its pid.
   */
  export async function queryHostPid(session: QLAppSession): Promise<number> {
    return session.app.evaluate(({ app }, serviceName) => {
      const metric = app.getAppMetrics().find(candidate => candidate.name === serviceName)
      return metric?.pid
    }, QueryHostLauncher.ServiceName)
  }

  /**
   * Set the appearance through the renderer's own bridge (`window.wireQL`), as the
   * View menu does. The bridge key, channel and source travel as evaluate arguments:
   * the closure runs in the page and cannot reach this module's imports.
   *
   * @param page - The window.
   * @param source - The appearance.
   */
  export async function setThemeSource(page: Page, source: ThemeSource): Promise<void> {
    await page.evaluate(
      ([key, channel, themeSource]) => (window as unknown as Record<string, QLBridge>)[key].invoke(channel, { source: themeSource }),
      [QLBridge.Key, IPCChannel.setThemeSource, source] as const
    )
  }

  /**
   * `typeof window[name]` inside the page (the renderer's view of a global).
   *
   * @param page - The window.
   * @param name - The global's name.
   * @returns Its `typeof`.
   */
  export async function globalType(page: Page, name: string): Promise<string> {
    return page.evaluate(globalName => typeof (window as unknown as Record<string, unknown>)[globalName], name)
  }

  /**
   * Replace the SQL of the focused editor (Monaco model) and run it with Ctrl+Enter.
   *
   * @param page - The window.
   * @param sql - The query.
   */
  export async function runQuery(page: Page, sql: string): Promise<void> {
    await setEditorText(page, sql)
    await page.getByRole("button", { name: "Run", exact: true }).click()
  }

  /**
   * Replace the SQL of the focused editor.
   *
   * @param page - The window.
   * @param sql - The text.
   */
  export async function setEditorText(page: Page, sql: string): Promise<void> {
    const editor = page.locator(".monaco-editor .view-lines").first()
    await editor.click()
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.press("Delete")
    await page.keyboard.insertText(sql)
  }
}
