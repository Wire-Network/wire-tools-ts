import Os from "node:os"
import Path from "node:path"

import { defaults } from "lodash"
import { match } from "ts-pattern"

/** Environment / platform inputs of path resolution (injectable for tests). */
export interface QLPathsOptions {
  /** Environment variables (default `process.env`). */
  environment?: NodeJS.ProcessEnv
  /** Platform (default `process.platform`). */
  platform?: NodeJS.Platform
  /** Home directory (default `os.homedir()`). */
  homePath?: string
}

/** Resolved path inputs. */
export interface QLPathsConfig extends Required<QLPathsOptions> {}

/**
 * Defaults for {@link QLPathsOptions}.
 *
 * @returns The current process's environment, platform and home.
 */
export function createQLPathsDefaultOptions(): Partial<QLPathsOptions> {
  return { environment: process.env, platform: process.platform, homePath: Os.homedir() }
}

/**
 * The platforms WIRE QL is built and packaged for (values are `process.platform`
 * spellings). Linux and every other POSIX platform use the XDG directories.
 */
export enum QLPlatform {
  linux = "linux",
  darwin = "darwin",
  win32 = "win32"
}

/** Where WIRE QL keeps its files — shared by CLI, TUI and GUI. */
export namespace QLPaths {
  /** Application directory name. */
  export const AppDirectoryName = "wire-ql"
  /** Profiles document. */
  export const ProfilesFilename = "profiles.json"
  /** Saved-queries document. */
  export const SavedQueriesFilename = "saved-queries.json"
  /** History log (JSON lines). */
  export const HistoryFilename = "history.jsonl"
  /** Log subdirectory of the state path. */
  export const LogsSubpath = "logs"
  /** macOS: configuration under `~/Library/Application Support`. */
  export const DarwinConfigSubpath = ["Library", "Application Support"] as const
  /** macOS: state/logs under `~/Library/Logs`. */
  export const DarwinStateSubpath = ["Library", "Logs"] as const
  /** Windows: roaming configuration fallback when `%APPDATA%` is unset. */
  export const WindowsRoamingSubpath = ["AppData", "Roaming"] as const
  /** Windows: local state fallback when `%LOCALAPPDATA%` is unset. */
  export const WindowsLocalSubpath = ["AppData", "Local"] as const
  /** XDG: configuration fallback when `$XDG_CONFIG_HOME` is unset. */
  export const XdgConfigSubpath = [".config"] as const
  /** XDG: state fallback when `$XDG_STATE_HOME` is unset. */
  export const XdgStateSubpath = [".local", "state"] as const

  /** The directory-convention inputs of one path family (config or state). */
  interface PlatformLocations {
    /** macOS subpath of home. */
    darwin: readonly string[]
    /** Windows environment variable naming the base directory. */
    windowsVariable: string
    /** Windows home-relative fallback when the variable is unset. */
    windowsFallback: readonly string[]
    /** XDG environment variable naming the base directory. */
    xdgVariable: string
    /** XDG home-relative fallback when the variable is unset. */
    xdgFallback: readonly string[]
  }

  /** Configuration directory conventions. */
  const ConfigLocations: PlatformLocations = {
    darwin: DarwinConfigSubpath,
    windowsVariable: "APPDATA",
    windowsFallback: WindowsRoamingSubpath,
    xdgVariable: "XDG_CONFIG_HOME",
    xdgFallback: XdgConfigSubpath
  }

  /** State directory conventions. */
  const StateLocations: PlatformLocations = {
    darwin: DarwinStateSubpath,
    windowsVariable: "LOCALAPPDATA",
    windowsFallback: WindowsLocalSubpath,
    xdgVariable: "XDG_STATE_HOME",
    xdgFallback: XdgStateSubpath
  }

  /** Resolve options over the process defaults (lodash `defaults`: an explicit undefined keeps the default). */
  function resolve(options: QLPathsOptions): QLPathsConfig {
    return defaults({ ...options }, createQLPathsDefaultOptions()) as QLPathsConfig
  }

  /** Path module of a platform (win32 separators on Windows). */
  function pathModule(platform: NodeJS.Platform): typeof Path.posix {
    return platform === QLPlatform.win32 ? Path.win32 : Path.posix
  }

  /** The application directory of one path family on the resolved platform. */
  function appDirectory(locations: PlatformLocations, options: QLPathsOptions): string {
    const { environment, platform, homePath } = resolve(options),
      paths = pathModule(platform),
      base = match(platform)
        .with(QLPlatform.darwin, () => paths.join(homePath, ...locations.darwin))
        .with(QLPlatform.win32, () => environment[locations.windowsVariable] ?? paths.join(homePath, ...locations.windowsFallback))
        .otherwise(() => environment[locations.xdgVariable] ?? paths.join(homePath, ...locations.xdgFallback))
    return paths.join(base, AppDirectoryName)
  }

  /** `entry` under `directory`, joined with the resolved platform's separators. */
  function under(directory: string, entry: string, options: QLPathsOptions): string {
    return pathModule(resolve(options).platform).join(directory, entry)
  }

  /**
   * Configuration directory: `$XDG_CONFIG_HOME/wire-ql` (fallback `~/.config/wire-ql`),
   * `~/Library/Application Support/wire-ql`, `%APPDATA%\wire-ql`.
   *
   * @param options - Environment / platform / home overrides.
   * @returns The directory.
   */
  export function configPath(options: QLPathsOptions = {}): string {
    return appDirectory(ConfigLocations, options)
  }

  /**
   * State/log directory: `$XDG_STATE_HOME/wire-ql` (fallback `~/.local/state/wire-ql`),
   * `~/Library/Logs/wire-ql`, `%LOCALAPPDATA%\wire-ql`.
   *
   * @param options - Environment / platform / home overrides.
   * @returns The directory.
   */
  export function statePath(options: QLPathsOptions = {}): string {
    return appDirectory(StateLocations, options)
  }

  /**
   * `profiles.json` under {@link configPath}.
   *
   * @param options - Path overrides.
   * @returns The file.
   */
  export function profilesFile(options: QLPathsOptions = {}): string {
    return under(configPath(options), ProfilesFilename, options)
  }

  /**
   * `saved-queries.json` under {@link configPath}.
   *
   * @param options - Path overrides.
   * @returns The file.
   */
  export function savedQueriesFile(options: QLPathsOptions = {}): string {
    return under(configPath(options), SavedQueriesFilename, options)
  }

  /**
   * `history.jsonl` under {@link statePath}.
   *
   * @param options - Path overrides.
   * @returns The file.
   */
  export function historyFile(options: QLPathsOptions = {}): string {
    return under(statePath(options), HistoryFilename, options)
  }

  /**
   * `logs/` under {@link statePath}.
   *
   * @param options - Path overrides.
   * @returns The directory.
   */
  export function logsPath(options: QLPathsOptions = {}): string {
    return under(statePath(options), LogsSubpath, options)
  }
}
