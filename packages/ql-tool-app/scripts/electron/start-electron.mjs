#!/usr/bin/env node
/**
 * Start the built app (the package's `main`, dist/app/main.js) with the
 * Electron binary from node_modules, adding `--no-sandbox` only on hosts that
 * cannot run Chromium's OS sandbox (see electron-launcher.cjs).
 *
 * Usage:
 *   ./scripts/electron/start-electron.mjs
 *
 * Exit codes:
 *   Electron's own exit code (0 when the app quits normally).
 *
 * Examples:
 *   pnpm --filter @wireio/ql-tool-app start
 */
import { createRequire } from "node:module"

import { path } from "zx"

const require = createRequire(import.meta.url),
  { spawnApp } = require("./electron-launcher.cjs"),
  { PackagePath } = require("../../etc/app-identity/app-identity.cjs"),
  { main: MainBundle } = require("../../package.json")

spawnApp(path.join(PackagePath, MainBundle)).once("exit", code => process.exit(code ?? 0))
