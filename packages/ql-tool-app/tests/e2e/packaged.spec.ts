import Fs from "node:fs"

import { expect } from "@playwright/test"

import { ExecutionFixtures } from "../common/ExecutionFixtures.js"
import { E2EPaths } from "./common/E2EPaths.js"
import { PackagedApp } from "./common/PackagedApp.js"
import { QLAppHarness } from "./common/QLAppHarness.js"
import { test } from "./common/QLAppTest.js"

/** This host's `--dir` packaged executable, resolved from etc/electron-builder/electron-builder.config.cjs (every platform). */
const Packaged = PackagedApp.resolveForHost(E2EPaths.PackagePath)

test("the packaged app (query host forked from inside app.asar) runs a query to a populated grid", async ({ launchConnected }) => {
  expect(Fs.existsSync(Packaged.executablePath), `packaged app not built (${Packaged.executablePath}); run: ${Packaged.buildHint}`).toBe(
    true
  )
  const session = await launchConnected({ executablePath: Packaged.executablePath }),
    { page } = session
  await QLAppHarness.runQuery(page, ExecutionFixtures.PositionsQuery)
  await expect(page.getByTestId("results-grid")).toContainText("alice")
  expect(QLAppHarness.cspViolations(session)).toEqual([])
})
