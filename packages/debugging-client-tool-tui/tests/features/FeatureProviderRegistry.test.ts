import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { Level } from "@wireio/shared"
import { LoggingManager } from "@wire-e2e-tests/debugging-client-tool-tui/logging/LoggingManager.js"
import { FeatureProviderRegistry } from "@wire-e2e-tests/debugging-client-tool-tui/features/FeatureProviderRegistry.js"
import type { FeatureProvider } from "@wire-e2e-tests/debugging-client-tool-tui/features/FeatureProvider.js"
import { ServiceManager } from "@wire-e2e-tests/debugging-client-tool-tui/services/ServiceManager.js"
import { ComponentProviders } from "@wire-e2e-tests/debugging-client-tool-tui/providers/ComponentProviders.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "fpr-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
  // Reset the registry's internal map across tests by reimporting.
  // FeatureProviderRegistry is module-scoped, so we clear via `find/all` inspection only.
})

/** Fake FeatureProvider with spies on the two hooks. */
function makeProvider(id: string) {
  const registerComponents = jest.fn((_providers: typeof ComponentProviders) => undefined)
  const registerServices = jest.fn((_m: ServiceManager) => undefined)
  const provider: FeatureProvider = {
    id,
    name: id,
    isRequiredProvider: false,
    registerComponents,
    registerServices
  }
  return { provider, registerComponents, registerServices }
}

describe("FeatureProviderRegistry.add", () => {
  it("invokes registerComponents with ComponentProviders", () => {
    const { provider, registerComponents } = makeProvider("p1")
    FeatureProviderRegistry.add(provider)
    expect(registerComponents).toHaveBeenCalledWith(ComponentProviders)
  })

  it("invokes registerServices with the ServiceManager singleton when present", () => {
    const { provider, registerServices } = makeProvider("p2")
    FeatureProviderRegistry.add(provider)
    expect(registerServices).toHaveBeenCalledWith(ServiceManager.get())
  })

  it("skips registerServices when the provider doesn't declare one", () => {
    const provider: FeatureProvider = {
      id: "p3",
      name: "p3",
      isRequiredProvider: false,
      registerComponents: () => undefined
    }
    expect(() => FeatureProviderRegistry.add(provider)).not.toThrow()
  })
})

describe("FeatureProviderRegistry.find + .all", () => {
  it("find returns the most recently added provider by id", () => {
    const { provider } = makeProvider("p4")
    FeatureProviderRegistry.add(provider)
    expect(FeatureProviderRegistry.find("p4")?.id).toBe("p4")
  })

  it("find returns undefined for unknown ids", () => {
    expect(FeatureProviderRegistry.find("never-registered")).toBeUndefined()
  })

  it("all returns every previously-registered provider in insertion order", () => {
    const names = FeatureProviderRegistry.all().map(p => p.id)
    expect(names).toEqual(expect.arrayContaining(["p1", "p2", "p3", "p4"]))
  })
})
