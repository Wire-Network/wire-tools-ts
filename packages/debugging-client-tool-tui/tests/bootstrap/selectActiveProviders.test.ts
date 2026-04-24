import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import {
  selectActiveProviders,
  warnUnknownFeatureIds
} from "@wire-e2e-tests/debugging-client-tool-tui/bootstrap/selectActiveProviders.js"
import type { FeatureProvider } from "@wire-e2e-tests/debugging-client-tool-tui/features/FeatureProvider.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "boot-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

function mkProvider(id: string, required = false): FeatureProvider {
  return {
    id,
    name: id,
    isRequiredProvider: required,
    registerComponents: () => undefined
  }
}

describe("selectActiveProviders", () => {
  const required = mkProvider("process-monitor", true),
    opp = mkProvider("opp"),
    custom = mkProvider("custom")
  const all = [required, opp, custom] as const

  it("returns every provider when filter is null", () => {
    expect(selectActiveProviders(all, null).map(p => p.id)).toEqual([
      "process-monitor",
      "opp",
      "custom"
    ])
  })

  it("keeps required providers even if the filter excludes them", () => {
    const active = selectActiveProviders(all, new Set(["opp"]))
    expect(active.map(p => p.id)).toEqual(["process-monitor", "opp"])
  })

  it("lowercases the id when matching against the filter (case-insensitive)", () => {
    const upperCase = mkProvider("OPP")
    expect(
      selectActiveProviders([upperCase] as any, new Set(["opp"])).map(p => p.id)
    ).toEqual(["OPP"])
  })

  it("filter with unknown ids excludes every non-required provider", () => {
    expect(
      selectActiveProviders(all, new Set(["nonexistent"])).map(p => p.id)
    ).toEqual(["process-monitor"])
  })
})

describe("warnUnknownFeatureIds", () => {
  it("is a no-op when every filter id matches an active id", () => {
    // Assert: calling the function does not throw.
    expect(() =>
      warnUnknownFeatureIds(new Set(["opp"]), ["opp", "process-monitor"])
    ).not.toThrow()
  })

  it("accepts unknown ids without throwing (logs a warning)", () => {
    expect(() =>
      warnUnknownFeatureIds(new Set(["opp", "bogus"]), ["opp"])
    ).not.toThrow()
  })
})
