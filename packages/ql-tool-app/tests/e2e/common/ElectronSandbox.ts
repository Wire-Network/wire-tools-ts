import Path from "node:path"

import { E2EPaths } from "./E2EPaths.js"

/** The members of `scripts/electron/electron-launcher.cjs` the e2e suite reads. */
export interface ElectronLauncherModule {
  /** Chromium switch disabling the OS process sandbox. */
  NoSandboxSwitch: string
  /** Whether the setuid `chrome-sandbox` helper next to `electronBinary` is usable. */
  hasSetUidHelper(electronBinary: string): boolean
  /** Whether unprivileged user namespaces are available. */
  hasUserNamespaces(): boolean
  /** Extra Electron switches this host needs (`--no-sandbox` when no OS sandbox is available). */
  sandboxSwitches(electronBinary: string): string[]
}

/**
 * The e2e launch's Chromium OS-sandbox decision, read from the SAME module the
 * `start` script and the `dev` server use (scripts/electron/electron-launcher.cjs),
 * so every launch of the unpackaged app decides it one way.
 */
export namespace ElectronSandbox {
  /** The launcher module. */
  export const LauncherFile = Path.join(E2EPaths.PackagePath, "scripts", "electron", "electron-launcher.cjs")
  /** The launcher module's exports. */
  export const Launcher = require(LauncherFile) as ElectronLauncherModule

  /**
   * Extra Electron switches for this host.
   *
   * @param electronBinary - The Electron executable.
   * @returns `[]`, or `["--no-sandbox"]` when no OS sandbox is available.
   */
  export function switches(electronBinary: string): string[] {
    return Launcher.sandboxSwitches(electronBinary)
  }
}
