// preload bundle — ONE sandbox-loadable file. Under Electron's default sandbox a
// preload may `require` only `electron` (and a few polyfilled modules), so the
// bundle is built for `target: "web"` — every dependency is bundled with its
// browser entry and NO Node builtin is left as a runtime require — and only
// `electron` is external. (`electron-preload` leaves Node builtins external,
// which a sandboxed preload cannot load.)
import { AppOutputPath, AppPaths, createCommonConfig, WebTarget } from "./webpack.common.mjs"

/**
 * The preload bundle.
 *
 * @param {object} _env webpack env
 * @param {{ mode?: string }} argv webpack-cli arguments
 * @returns {import("webpack").Configuration}
 */
export function createPreloadConfig(_env, argv) {
  return {
    ...createCommonConfig(
      {
        name: "preload",
        target: WebTarget,
        entry: { preload: "./src/preload/preload.ts" },
        outputPath: AppOutputPath,
        dirname: "mock",
        output: { filename: AppPaths.PreloadFilename, chunkFormat: "array-push", chunkLoading: false, asyncChunks: false }
      },
      argv
    ),
    externalsType: "commonjs",
    externals: { electron: "electron" },
    optimization: { splitChunks: false }
  }
}
