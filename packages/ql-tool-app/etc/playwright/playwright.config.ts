import Path from "node:path"

import { defineConfig } from "@playwright/test"

import { E2EPaths } from "../../tests/e2e/common/E2EPaths.js"

/**
 * Playwright `_electron` e2e (local; Linux runs on Xvfb or a nested Xephyr —
 * a dedicated xvfb CI job is a follow-up). `test:e2e` builds the webpack bundles
 * and installs the Electron binary first. One worker: each test owns an app
 * instance, a stub engine and an isolated home. Playwright WIPES `outputDir`
 * before globalSetup runs, so its artifacts live in `dist/test-results/playwright`
 * while the virtual display's pid record (read by the next run's globalSetup to
 * reap a display an interrupted run left behind) sits beside it in
 * `dist/test-results/`.
 */
export default defineConfig({
  testDir: E2EPaths.SuitePath,
  testMatch: "**/*.spec.ts",
  globalSetup: Path.join(E2EPaths.SuitePath, "globalSetup.ts"),
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: E2EPaths.PlaywrightOutputPath
})
