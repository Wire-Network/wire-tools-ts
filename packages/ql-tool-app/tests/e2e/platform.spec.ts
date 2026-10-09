import { expect } from "@playwright/test"

import { QLBridge, QLContentSecurityPolicy, ThemeSource } from "@wireio/ql-tool-app/common"
import { AppPaths } from "@wireio/ql-tool-app/main"
import { MainLogging } from "@wireio/ql-tool-app/main/logging"
import { QueryHostProcess } from "@wireio/ql-tool-app/query-host"

import { QLAppHarness, type LastWebPreferencesAccessor } from "./common/QLAppHarness.js"
import { test } from "./common/QLAppTest.js"
import { StaticRendererServer } from "./common/StaticRendererServer.js"

/** Brand blue as a computed color. */
const KeywordLightColor = "rgb(47, 107, 255)"

test("a query goes renderer → port → utilityProcess → stub and back to a populated grid", async ({ launchConnected, stub }) => {
  const { page } = await launchConnected()
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.positions")
  const grid = page.getByTestId("results-grid")
  await expect(grid).toContainText("alice")
  await expect(grid).toContainText("carol")
  expect(stub.requests.at(-1).params).toMatchObject({ query: "SELECT * FROM sample.positions", limit: 100, offset: 0 })
})

test("local Monaco under the CSP — semantic tokens + JSON tab offline, zero CSP violations", async ({ launch }) => {
  const session = await launch(),
    { page } = session,
    networkRequests: string[] = []
  page.on("request", request => {
    if (/^https?:/.test(request.url())) networkRequests.push(request.url())
  })
  await QLAppHarness.setThemeSource(page, ThemeSource.light)
  await expect(page.getByTestId("host-connected")).toBeVisible()
  await QLAppHarness.setEditorText(page, "SELECT name FROM sample.positions")
  const keyword = page.locator(".monaco-editor .view-lines span span", { hasText: /^SELECT$/ }).first()
  await expect(keyword).toHaveCSS("color", KeywordLightColor)
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByTestId("results-grid")).toContainText("bob")
  await page.getByTestId("panel-json").click()
  await expect(page.locator(".monaco-editor").nth(1)).toContainText("alice")
  expect(networkRequests).toEqual([])
  expect(QLAppHarness.cspViolations(session)).toEqual([])
})

test("every bundle logs its own src/... category (main, preload, query host, renderer)", async ({ launchConnected }) => {
  const session = await launchConnected()
  await QLAppHarness.runQuery(session.page, "SELECT * FROM sample.positions")
  await expect(session.page.getByTestId("results-grid")).toContainText("alice")
  await expect
    .poll(() => QLAppHarness.logRecords(session, MainLogging.RendererLogFilename).map(record => record.category))
    .toEqual(expect.arrayContaining(["preload:preload", "renderer:App", "renderer:query:QueryPortClient"]))
  expect(QLAppHarness.logRecords(session, MainLogging.MainLogFilename).map(record => record.category)).toEqual(
    expect.arrayContaining(["main:AppLifecycle", "main:query:QueryHostLauncher", "main:windows:WindowManager"])
  )
  await expect
    .poll(() => QLAppHarness.logRecords(session, QueryHostProcess.LogFilename).map(record => record.category))
    .toEqual(expect.arrayContaining(["query-host:main", "query-host:QueryHost", "cjs:client:QueryEngineClient"]))
})

test("standard defaults — isolated, sandboxed, Node-free renderer with the bridge, port and CSP", async ({ launchConnected }) => {
  const session = await launchConnected(),
    { page, app } = session
  expect(await QLAppHarness.globalType(page, "require")).toBe("undefined")
  expect(await QLAppHarness.globalType(page, "process")).toBe("undefined")
  expect(await QLAppHarness.globalType(page, QLBridge.Key)).toBe("object")
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const webContents = BrowserWindow.getAllWindows()[0].webContents as unknown as LastWebPreferencesAccessor,
      { contextIsolation, nodeIntegration, sandbox } = webContents.getLastWebPreferences()
    return { contextIsolation, nodeIntegration, sandbox }
  })
  expect(preferences.contextIsolation).toBe(true)
  expect(preferences.nodeIntegration).toBe(false)
  expect(preferences.sandbox).not.toBe(false)
  expect(
    await page.evaluate(() => document.querySelector("meta[http-equiv='Content-Security-Policy']")?.getAttribute("content"))
  ).toBe(QLContentSecurityPolicy.Production)
  // The port reached the isolated world (a query ran through it) and emotion styles applied under the CSP.
  await QLAppHarness.runQuery(page, "SELECT * FROM sample.positions")
  await expect(page.getByTestId("results-grid")).toContainText("alice")
  expect(await page.evaluate(() => document.querySelectorAll("style[data-emotion]").length)).toBeGreaterThan(0)
  expect(QLAppHarness.cspViolations(session)).toEqual([])
})

test("window.open is denied and navigation away from the renderer is blocked", async ({ launchConnected }) => {
  const session = await launchConnected(),
    { page, app } = session,
    rendererURL = page.url(),
    windowURL = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  expect(await page.evaluate(() => window.open("https://example.com/") == null)).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await page.evaluate(() => {
    window.location.href = "https://example.com/"
  })
  await expect
    .poll(() => QLAppHarness.logRecords(session, MainLogging.MainLogFilename).map(record => String(record.message)))
    .toEqual(expect.arrayContaining([expect.stringMatching(/^blocked navigation of window \d+ to https:\/\/example\.com\//)]))
  expect(await windowURL()).toBe(rendererURL)
})

test("an http (dev-server) load gets the CSP response header and still works", async ({ launch }) => {
  const server = await StaticRendererServer.start()
  try {
    const session = await launch({ environment: { [AppPaths.DevServerURLEnvironmentVariable]: server.url } }),
      { page } = session,
      response = await page.reload()
    expect(response.headers()["content-security-policy"]).toBe(QLContentSecurityPolicy.Development)
    await expect(page.getByTestId("host-connected")).toBeVisible()
    await QLAppHarness.runQuery(page, "SELECT * FROM sample.positions")
    await expect(page.getByTestId("results-grid")).toContainText("alice")
    expect(QLAppHarness.cspViolations(session)).toEqual([])
  } finally {
    await server.close()
  }
})
