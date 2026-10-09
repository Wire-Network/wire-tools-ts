// main bundle — `electron-main` target (electron + Node builtins external);
// `__dirname` stays real so the preload / query-host / renderer paths resolve
// next to main.js (named by AppPaths.MainFilename).
import { AppManifestPlugin, AppOutputPath, AppPaths, createCommonConfig, RuntimeIconsPlugin } from "./webpack.common.mjs"

/**
 * The main bundle.
 *
 * @param {object} _env webpack env
 * @param {{ mode?: string }} argv webpack-cli arguments
 * @returns {import("webpack").Configuration}
 */
export function createMainConfig(_env, argv) {
  return {
    ...createCommonConfig(
      {
        name: "main",
        target: "electron-main",
        entry: { main: "./src/main/main.ts" },
        outputPath: AppOutputPath,
        output: { filename: AppPaths.MainFilename }
      },
      argv
    ),
    plugins: [new RuntimeIconsPlugin(), new AppManifestPlugin()]
  }
}
