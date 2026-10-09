// renderer bundle — `target: "web"`: the isolated, sandboxed renderer has NO
// Node (see WebFallback in webpack.common.mjs).
// Monaco runs locally (no CDN): monaco-editor-webpack-plugin emits the editor
// and JSON workers as local files loaded from `self` (CSP `worker-src 'self'
// blob:`). html-webpack-plugin injects the CSP <meta> from the ONE constant in
// src/common/QLContentSecurityPolicy.ts — Production for builds, the meta-safe
// DevelopmentMeta (no header-only directive) for the dev server, whose
// response header main sets to the full Development policy.
import { createRequire } from "node:module"
import Path from "node:path"

import HtmlWebpackPlugin from "html-webpack-plugin"
import MonacoWebpackPlugin from "monaco-editor-webpack-plugin"

import {
  AppOutputPath,
  AppPaths,
  createCommonConfig,
  Identity,
  importTypeScriptModule,
  PackagePath,
  RendererOutputPath,
  WebTarget
} from "./webpack.common.mjs"

const require = createRequire(import.meta.url),
  MonacoEditorPath = Path.join(PackagePath, "node_modules", "monaco-editor"),
  /** Preferred dev-server port; the bind registry confirms or replaces it. */
  DevServerPreferredPort = 9_618

/** Resolve a registry-issued dev-server port (every port comes from the bind registry). */
async function resolveDevServerPort() {
  const { BindConfigProvider } = require("@wireio/cluster-tool")
  const port = await BindConfigProvider.findAvailable(DevServerPreferredPort)
  await BindConfigProvider.clearPortLocks()
  return port
}

/** After the dev server listens, launch Electron against it (main/preload/query-host were built first). */
function launchElectron(devServer) {
  const { spawnApp } = require("../../scripts/electron/electron-launcher.cjs"),
    url = `http://localhost:${devServer.server.address().port}/`
  spawnApp(Path.join(AppOutputPath, AppPaths.MainFilename), {
    ...process.env,
    [AppPaths.DevServerURLEnvironmentVariable]: url
  }).once("exit", code => process.exit(code ?? 0))
}

/**
 * The renderer bundle (plus the dev server under `webpack serve`).
 *
 * @param {{ WEBPACK_SERVE?: boolean }} env webpack env
 * @param {{ mode?: string }} argv webpack-cli arguments
 * @returns {Promise<import("webpack").Configuration>}
 */
export async function createRendererConfig(env = {}, argv = {}) {
  const serving = env.WEBPACK_SERVE === true,
    { QLContentSecurityPolicy } = await importTypeScriptModule(
      Path.join(PackagePath, "src", "common", "QLContentSecurityPolicy.ts")
    ),
    common = createCommonConfig(
      {
        name: "renderer",
        target: WebTarget,
        entry: { renderer: "./src/renderer/index.tsx" },
        outputPath: RendererOutputPath,
        dirname: "mock",
        output: { publicPath: "auto", globalObject: "self", clean: false }
      },
      argv
    )
  return {
    ...common,
    module: {
      rules: [
        ...common.module.rules,
        { test: /\.css$/, use: ["style-loader", "css-loader"] },
        { test: /\.ttf$/, type: "asset/inline" },
        { test: /\.m?js$/, resolve: { fullySpecified: false } }
      ]
    },
    plugins: [
      new HtmlWebpackPlugin({
        title: Identity.ProductName,
        template: Path.join(PackagePath, "resources", "index.html"),
        filename: AppPaths.RendererFilename,
        meta: {
          [QLContentSecurityPolicy.HeaderName]: {
            "http-equiv": QLContentSecurityPolicy.HeaderName,
            content: serving ? QLContentSecurityPolicy.DevelopmentMeta : QLContentSecurityPolicy.Production
          }
        }
      }),
      new MonacoWebpackPlugin({ languages: ["json"], filename: "[name].worker.js", monacoEditorPath: MonacoEditorPath })
    ],
    ...(serving && {
      devServer: {
        port: await resolveDevServerPort(),
        hot: true,
        static: false,
        devMiddleware: { writeToDisk: false },
        onListening: launchElectron
      }
    })
  }
}
