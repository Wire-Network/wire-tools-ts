import Fs from "node:fs"
import Path from "node:path"

import { E2EPaths } from "./E2EPaths.js"

describe("E2EPaths", () => {
  it("resolves the package root through the app identity module", () => {
    expect(Fs.existsSync(E2EPaths.AppIdentityFile)).toBe(true)
    expect(Fs.existsSync(Path.join(E2EPaths.PackagePath, "package.json"))).toBe(true)
    expect(E2EPaths.SuitePath).toBe(Path.resolve(__dirname, ".."))
  })

  it("keeps test output under dist/test-results, Playwright's in its own subdirectory", () => {
    expect(E2EPaths.TestResultsPath).toBe(Path.join(E2EPaths.PackagePath, "dist", "test-results"))
    expect(Path.dirname(E2EPaths.PlaywrightOutputPath)).toBe(E2EPaths.TestResultsPath)
  })
})
