import Path from "node:path"
import { pathToFileURL } from "node:url"

/** Where the bundled app's files are (everything sits next to `main.js`). */
export interface AppPaths {
  /** The sandboxed preload bundle. */
  preloadFile: string
  /** The query-host bundle forked as a utilityProcess. */
  hostModuleFile: string
  /** The renderer page (file:// in packaged runs, the dev server when configured). */
  rendererURL: string
  /** Window / taskbar icon. */
  iconFile: string
}

/** Path layout of the webpack output (`dist/app/`) and the environment that relocates it. */
export namespace AppPaths {
  /** Main bundle file name (the packaged app's entry; the webpack `main` entry). */
  export const MainFilename = "main.js"
  /** Preload bundle file name. */
  export const PreloadFilename = "preload.js"
  /** Query-host bundle file name. */
  export const HostModuleFilename = "query-host.js"
  /** Renderer directory (html-webpack-plugin output). */
  export const RendererSubpath = "renderer"
  /** Renderer page file name. */
  export const RendererFilename = "index.html"
  /** Brand assets copied next to main.js. */
  export const AssetsSubpath = "assets"
  /** Runtime icon (Linux/Windows taskbar, macOS dock in development). */
  export const IconFilename = "icon-512.png"
  /** Environment variable pointing the renderer at a dev server (`webpack serve`) or any http origin. */
  export const DevServerURLEnvironmentVariable = "WIRE_QL_DEV_SERVER_URL"
  /** Environment variable relocating userData (and the logs under it) — used by isolated runs (e2e). */
  export const UserDataEnvironmentVariable = "WIRE_QL_USER_DATA_PATH"

  /**
   * Resolve every path from the directory holding `main.js`.
   *
   * @param appPath - The bundle directory (`__dirname` of main).
   * @param environment - Process environment (dev-server override).
   * @returns The paths.
   */
  export function resolve(appPath: string, environment: NodeJS.ProcessEnv = process.env): AppPaths {
    const devServerURL = environment[DevServerURLEnvironmentVariable]
    return {
      preloadFile: Path.join(appPath, PreloadFilename),
      hostModuleFile: Path.join(appPath, HostModuleFilename),
      rendererURL: devServerURL ?? pathToFileURL(Path.join(appPath, RendererSubpath, RendererFilename)).toString(),
      iconFile: Path.join(appPath, AssetsSubpath, IconFilename)
    }
  }
}
