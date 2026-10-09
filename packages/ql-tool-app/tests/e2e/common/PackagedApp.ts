import Fs from "node:fs"
import Path from "node:path"

import type { Configuration } from "electron-builder"
import { match } from "ts-pattern"

import { QLPlatform } from "@wireio/ql-shared/node"
import { NestedError } from "@wireio/shared"

/** Where a platform's `--dir` build puts the app, and how to produce it. */
export interface PackagedExecutable {
  /** The executable to launch. */
  executablePath: string
  /** The command that builds it. */
  buildHint: string
}

/**
 * Resolves the executable of electron-builder's unpacked (`--dir`) output for
 * each platform from the package's own `etc/electron-builder/electron-builder.config.cjs`, with
 * electron-builder's own name precedence: `<platform>.executableName`, then the
 * top-level `executableName`, then the product name (lower-cased on Linux).
 *
 * - linux: `<output>/linux-unpacked/<name>`
 * - win32: `<output>/win-unpacked/<name>.exe`
 * - darwin: `<output>/mac[-<arch>]/<name>.app/Contents/MacOS/<name>` (the
 *   arch-suffixed directory a non-default-arch build writes is picked up when present)
 */
export namespace PackagedApp {
  /** The builder configuration file (relative to the package root). */
  export const ConfigFile = Path.join("etc", "electron-builder", "electron-builder.config.cjs")
  /** electron-builder's output directory when the config names none. */
  export const DefaultOutputDirectory = "dist"
  /** Linux `--dir` output directory. */
  export const LinuxDirectory = "linux-unpacked"
  /** Windows `--dir` output directory. */
  export const WindowsDirectory = "win-unpacked"
  /** macOS `--dir` output directory (default arch; other archs append `-<arch>`). */
  export const MacDirectory = "mac"
  /** Windows executable extension. */
  export const WindowsExtension = ".exe"
  /** macOS bundle extension. */
  export const MacBundleExtension = ".app"
  /** Path of the executable inside a macOS bundle. */
  export const MacExecutableSubpath = Path.join("Contents", "MacOS")
  /**
   * The command producing this host's unpacked build (the package's `package:dir`
   * script — electron-builder `--dir` for the host platform, nothing else).
   */
  export const BuildHint = "pnpm --filter @wireio/ql-tool-app run package:dir"
  /** Characters electron-builder strips from file names. */
  export const UnsafeFileNameCharacters = /[/\\?%*:|"<>]/g

  /**
   * The unpacked executable of `platform` and its build command (pure).
   *
   * @param platform - The host platform.
   * @param config - The electron-builder configuration.
   * @param packagePath - The package root (builder paths are relative to it).
   * @param outputEntries - Entry names of the builder output directory (macOS arch directory lookup).
   * @returns The executable path and build hint.
   * @throws NestedError for a platform electron-builder does not package here.
   */
  export function resolve(platform: string, config: Configuration, packagePath: string, outputEntries: string[]): PackagedExecutable {
    const output = Path.resolve(packagePath, config.directories?.output ?? DefaultOutputDirectory),
      productName = config.productName
    return match(platform)
      .with(QLPlatform.linux, () => {
        const name = sanitize(config.linux?.executableName ?? config.executableName ?? sanitize(productName).toLowerCase())
        return { executablePath: Path.join(output, LinuxDirectory, name), buildHint: BuildHint }
      })
      .with(QLPlatform.win32, () => {
        const name = sanitize(config.win?.executableName ?? config.executableName ?? productName)
        return { executablePath: Path.join(output, WindowsDirectory, `${name}${WindowsExtension}`), buildHint: BuildHint }
      })
      .with(QLPlatform.darwin, () => {
        const name = sanitize(config.mac?.executableName ?? config.executableName ?? productName),
          directory = outputEntries.find(entry => entry === MacDirectory || entry.startsWith(`${MacDirectory}-`)) ?? MacDirectory
        return {
          executablePath: Path.join(output, directory, `${name}${MacBundleExtension}`, MacExecutableSubpath, name),
          buildHint: BuildHint
        }
      })
      .otherwise(() => {
        throw new NestedError(`no packaged app layout for platform ${platform}`, {
          context: { platform, platforms: Object.values(QLPlatform) }
        })
      })
  }

  /**
   * The executable of THIS host's `--dir` build, read from the real builder config.
   *
   * @param packagePath - The package root.
   * @returns The executable path and build hint.
   */
  export function resolveForHost(packagePath: string): PackagedExecutable {
    const config = require(Path.join(packagePath, ConfigFile)) as Configuration,
      output = Path.resolve(packagePath, config.directories?.output ?? DefaultOutputDirectory),
      entries = Fs.existsSync(output) ? Fs.readdirSync(output) : []
    return resolve(process.platform, config, packagePath, entries)
  }

  /** electron-builder's file-name sanitizing (unsafe characters dropped). */
  function sanitize(name: string): string {
    return name.replace(UnsafeFileNameCharacters, "")
  }
}
