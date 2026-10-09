// query-host bundle — plain Node (`target: "node"`), forked by main as an
// Electron utilityProcess; it never imports `electron` at runtime (types only),
// so plain Node can require it in the bundle smoke test.
import { AppOutputPath, AppPaths, createCommonConfig } from "./webpack.common.mjs"

/**
 * The query-host bundle.
 *
 * @param {object} _env webpack env
 * @param {{ mode?: string }} argv webpack-cli arguments
 * @returns {import("webpack").Configuration}
 */
export function createQueryHostConfig(_env, argv) {
  return createCommonConfig(
    {
      name: "query-host",
      target: "node",
      entry: { "query-host": "./src/query-host/main.ts" },
      outputPath: AppOutputPath,
      output: { filename: AppPaths.HostModuleFilename, library: { type: "commonjs2" } }
    },
    argv
  )
}
