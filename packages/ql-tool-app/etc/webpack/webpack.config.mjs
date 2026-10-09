// The ONE webpack config of ql-tool-app: the four bundles (main, preload,
// query-host, renderer) as an array — `--config-name <name>` builds a subset
// (the dev script builds main/preload/query-host, then serves the renderer).
import { createMainConfig } from "./webpack.config.main.mjs"
import { createPreloadConfig } from "./webpack.config.preload.mjs"
import { createQueryHostConfig } from "./webpack.config.query-host.mjs"
import { createRendererConfig } from "./webpack.config.renderer.mjs"

/**
 * Every bundle's config.
 *
 * @param {object} env webpack env
 * @param {{ mode?: string }} argv webpack-cli arguments
 * @returns {Promise<import("webpack").Configuration[]>}
 */
export default async (env = {}, argv = {}) => [
  createMainConfig(env, argv),
  createPreloadConfig(env, argv),
  createQueryHostConfig(env, argv),
  await createRendererConfig(env, argv)
]
