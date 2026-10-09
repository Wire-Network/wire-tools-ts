import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"

import { CatalogService, TuiServiceId } from "@wireio/ql-tool-cli/tui/index.js"

import { createResult, column } from "../../common/engineFixtures.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"

describe("CatalogService", () => {
  const engine = useStubEngine(() => ({ jsonrpc: JsonRPCProtocol.Version, result: createResult([column("name")], []) }))
  let harness: TuiHarness = null

  // Stopped even when a test fails midway (the started services hold watchers).
  afterEach(async () => {
    await harness?.registry.stopAll()
    harness = null
  })

  it("loads owners in the background and publishes snapshots", async () => {
    harness = await startTuiHarness(engine().endpoint)
    const service = harness.registry.get<CatalogService>(TuiServiceId.catalog)
    await service.loading
    const catalog = harness.store.getState().catalog
    expect(catalog.snapshot.owners[0]).toMatchObject({ account: "sample", loaded: true })
    expect(catalog).toMatchObject({ loading: false, error: null })
  })

  it("describes a table and invalidates (reloading) on SCHEMA_CHANGED", async () => {
    harness = await startTuiHarness(engine().endpoint)
    const service = harness.registry.get<CatalogService>(TuiServiceId.catalog)
    await service.loading
    await service.describe("sample", "positions")
    expect(harness.store.getState().catalog.snapshot.owners[0].tables[0].described).toBe(true)
    service.invalidate("sample")
    expect(harness.store.getState().catalog.snapshot.owners[0].loaded).toBe(false)
    await service.loading
    expect(harness.store.getState().catalog.snapshot.owners[0].loaded).toBe(true)
    expect(harness.chain.requested.filter(owner => owner === "sample").length).toBeGreaterThanOrEqual(2)
  })

  it("reports owners that fail to load and describe failures", async () => {
    harness = await startTuiHarness(engine().endpoint)
    const service = harness.registry.get<CatalogService>(TuiServiceId.catalog)
    service.useProfile({ ...harness.profile, owners: ["missing"] })
    await service.loading
    expect(harness.store.getState().catalog.error).toBe("could not load: missing")
    await service.describe("missing", "t")
    expect(harness.store.getState().catalog.error).toMatch(/describe missing\.t/)
  })
})
