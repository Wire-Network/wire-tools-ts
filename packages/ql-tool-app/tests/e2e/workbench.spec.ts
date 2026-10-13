import Fs from "node:fs"
import Path from "node:path"

import { expect, type Page } from "@playwright/test"

import { ThemeSource } from "@wireio/ql-tool-app/common"
import { QueryHostLauncher } from "@wireio/ql-tool-app/main/query"

import { ExecutionFixtures } from "../common/ExecutionFixtures.js"
import { StubQueryEngine } from "../common/StubQueryEngine.js"
import { QLAppHarness, type QLAppSession } from "./common/QLAppHarness.js"
import { test } from "./common/QLAppTest.js"

/** Time a respawn may take (backoff ≤ 8 s + spawn). */
const RespawnTimeoutMs = 30_000
/** Exits that push the launcher past its cap (MaxRestarts + 1). */
const CrashLoopExits = QueryHostLauncher.MaxRestarts + 1
/** How long a second (duplicate) request would take to show up after the first answer. */
const DuplicateRequestWindowMs = 1_500

/**
 * Kill the query host and wait until a NEW host process runs.
 *
 * @param current - The session.
 * @returns The new pid.
 */
async function killHostAndWait(current: QLAppSession): Promise<number> {
  const pid = await QLAppHarness.queryHostPid(current)
  process.kill(pid)
  await expect
    .poll(
      async () => {
        const next = await QLAppHarness.queryHostPid(current)
        return next != null && next !== pid
      },
      { timeout: RespawnTimeoutMs }
    )
    .toBe(true)
  return QLAppHarness.queryHostPid(current)
}

/**
 * The visible failure alert text.
 *
 * @param page - The window.
 * @returns The locator.
 */
function failureAlert(page: Page) {
  return page.getByTestId("result-failure")
}

test("theme follows the native appearance (setThemeSource) live", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await QLAppHarness.setThemeSource(page, ThemeSource.dark)
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true)
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 18, 18)")
  await QLAppHarness.setThemeSource(page, ThemeSource.light)
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false)
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)")
})

test("CmdOrCtrl+Enter runs; Grid / Form / JSON / Field Types / Stats / State / Messages tabs render", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await QLAppHarness.setEditorText(page, ExecutionFixtures.PositionsQuery)
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByTestId("results-grid")).toContainText("carol")
  await page.getByTestId("panel-form").click()
  await expect(page.getByTestId("form-view")).toContainText("alice")
  await page.getByTestId("panel-json").click()
  await expect(page.locator(".monaco-editor").nth(1)).toContainText("\"name\"")
  await page.getByTestId("panel-fieldTypes").click()
  await expect(page.getByTestId("field-types")).toContainText("asset_object")
  await page.getByTestId("panel-stats").click()
  await expect(page.getByTestId("stats-view")).toContainText("elapsed_us")
  await page.getByTestId("panel-state").click()
  await expect(page.getByTestId("state-view")).toContainText(StubQueryEngine.ChainId)
  await page.getByTestId("panel-messages").click()
  await expect(page.getByTestId("messages-view")).toContainText("3 of 3 rows")
})

test("ONE CmdOrCtrl+Enter in the editor sends exactly ONE request (editor chord and menu accelerator never both fire)", async ({
  launchConnected,
  stub
}) => {
  const { page } = await launchConnected(),
    query = "SELECT name FROM sample.positions WHERE amount > 0"
  await QLAppHarness.setEditorText(page, query)
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByTestId("results-grid")).toContainText("alice")
  await page.waitForTimeout(DuplicateRequestWindowMs)
  expect(stub.requests.filter(request => request.params.query === query)).toHaveLength(1)
})

test("server paging: next page is a new request; the differing-snapshot chip shows", async ({ launchConnected, stub }) => {
  const { page } = await launchConnected()
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.big")
  await expect(page.getByTestId("pager-label")).toContainText("page 1/100 · rows 1–100 of 10000 · block")
  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page.getByTestId("pager-label")).toContainText("page 2/100 · rows 101–200 of 10000")
  expect(stub.requests.at(-1).params).toMatchObject({ query: "SELECT * FROM sample.big", offset: 100, limit: 100 })
  await expect(page.getByText("page snapshot differs from previous page")).toBeVisible()
})

test("typing stays responsive while a 10k-row result loads; the grid is virtualized", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await page.getByLabel("Limit").fill("10000")
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.big")
  const started = Date.now()
  await page.locator(".monaco-editor .view-lines").first().click()
  await page.keyboard.press("End")
  await page.keyboard.type(" LIMIT 5")
  expect(Date.now() - started).toBeLessThan(5_000)
  await expect(page.getByTestId("status-outcome")).toContainText("10000 rows")
  expect(await page.getByTestId("results-grid").locator("tbody tr").count()).toBeLessThan(200)
})

test("reload the window, then a query succeeds on the new port", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await page.reload()
  await expect(page.getByTestId("host-connected")).toBeVisible()
  await QLAppHarness.runQuery(page, ExecutionFixtures.PositionsQuery)
  await expect(page.getByTestId("results-grid")).toContainText("alice")
})

test("kill the host mid-query: the in-flight query fails as transport (Retry enabled); the respawned host answers", async ({ launchConnected }) => {
  const current = await launchConnected(),
    { page } = current
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.slow")
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled()
  await killHostAndWait(current)
  await expect(failureAlert(page)).toContainText("transport: query host")
  await expect(page.getByRole("button", { name: "Retry" })).toBeEnabled()
  await expect(page.getByTestId("host-connected")).toBeVisible({ timeout: RespawnTimeoutMs })
  await QLAppHarness.runQuery(page, ExecutionFixtures.PositionsQuery)
  await expect(page.getByTestId("results-grid")).toContainText("bob")
})

test("reload during backoff, then a query is served once the host spawns", async ({ launchConnected }) => {
  const current = await launchConnected(),
    { page } = current,
    pid = await QLAppHarness.queryHostPid(current)
  process.kill(pid)
  await page.reload()
  await expect(page.getByTestId("host-connected")).toBeVisible({ timeout: RespawnTimeoutMs })
  await QLAppHarness.runQuery(page, ExecutionFixtures.PositionsQuery)
  await expect(page.getByTestId("results-grid")).toContainText("alice")
})

test("kill the host 6×: Run fails immediately with 'query host failed'; status-bar Restart recovers", async ({ launchConnected }) => {
  test.setTimeout(180_000)
  const current = await launchConnected(),
    { page } = current
  for (let exit = 1; exit < CrashLoopExits; exit += 1) await killHostAndWait(current)
  process.kill(await QLAppHarness.queryHostPid(current))
  await expect(page.getByTestId("host-failed")).toBeVisible({ timeout: RespawnTimeoutMs })
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled()
  await QLAppHarness.setEditorText(page, ExecutionFixtures.PositionsQuery)
  const started = Date.now()
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(failureAlert(page)).toContainText("query host failed")
  expect(Date.now() - started).toBeLessThan(5_000)
  await page.getByRole("button", { name: "Restart" }).click()
  await expect(page.getByTestId("host-connected")).toBeVisible({ timeout: RespawnTimeoutMs })
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByTestId("results-grid")).toContainText("alice")
})

test("export CSV through the (stubbed) native save dialog", async ({ launchConnected }) => {
  const current = await launchConnected(),
    { page, app } = current,
    file = Path.join(QLAppHarness.createRoot(), "results.csv")
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, file)
  await QLAppHarness.runQuery(page, ExecutionFixtures.PositionsQuery)
  await expect(page.getByTestId("results-grid")).toContainText("alice")
  await page.getByRole("button", { name: "Export" }).click()
  await page.getByRole("button", { name: "Export…" }).click()
  await expect.poll(() => Fs.existsSync(file)).toBe(true)
  const text = Fs.readFileSync(file, "utf8")
  expect(text.split(/\r?\n/)[0]).toBe("name,amount,balance")
  expect(text).toContain("alice")
})

test("history: an executed query appears in the drawer — one entry per run, retry and page fetch", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await QLAppHarness.runQuery(page, "SELECT name FROM sample.positions")
  await expect(page.getByTestId("results-grid")).toContainText("alice")
  await page.getByRole("button", { name: "History" }).click()
  await expect(page.getByTestId("history-list")).toContainText("SELECT name FROM sample.positions")
  await expect(page.getByTestId("history-list").getByRole("button", { name: /^Re-run / })).toHaveCount(1)
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.big")
  await expect(page.getByTestId("pager-label")).toContainText("page 1/100")
  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page.getByTestId("pager-label")).toContainText("page 2/100")
  await expect(page.getByTestId("history-list").getByRole("button", { name: /^Re-run / })).toHaveCount(3)
})

test("Stop cancels a running query", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.slow")
  await page.getByRole("button", { name: "Stop" }).click()
  await expect(failureAlert(page)).toContainText("cancelled")
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled()
})

test("Retry is offered only for retryable failures; a syntax error is marked in the editor", async ({ launchConnected }) => {
  const { page } = await launchConnected()
  await QLAppHarness.runQuery(page, "SELECT * FROM a.b JOIN c.d")
  await expect(failureAlert(page)).toContainText("QUERY_SYNTAX")
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled()
  await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible()
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.busy")
  await expect(failureAlert(page)).toContainText("QUERY_BUSY")
  await expect(page.getByRole("button", { name: "Retry" })).toBeEnabled()
})

test("window bounds are restored on relaunch", async ({ launch }) => {
  const rootPath = QLAppHarness.createRoot(),
    bounds = { x: 40, y: 50, width: 1_000, height: 700 },
    first = await launch({ rootPath })
  await first.app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), bounds)
  await first.app.close()
  const second = await launch({ rootPath }),
    restored = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds())
  expect(restored).toMatchObject({ width: bounds.width, height: bounds.height })
})
