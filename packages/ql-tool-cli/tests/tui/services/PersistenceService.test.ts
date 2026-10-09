import { QueryOutcome } from "@wireio/ql-shared"

import { PersistenceService, TuiServiceId, type PersistenceService as PersistenceServiceType } from "@wireio/ql-tool-cli/tui/index.js"

import { FixtureProfile } from "../../common/storeFixtures.js"
import { startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"
import { waitFor } from "../../common/waitFor.js"

describe("PersistenceService", () => {
  let harness: TuiHarness

  beforeEach(async () => {
    harness = await startTuiHarness(FixtureProfile.endpoint)
  })

  afterEach(() => harness.registry.stopAll())

  it("loads the documents at start and appends history", () => {
    const service = harness.registry.get<PersistenceServiceType>(TuiServiceId.persistence)
    expect(service).toBeInstanceOf(PersistenceService)
    service.appendHistory({ id: "h", profile: "p", query: "q", executedAt: new Date().toISOString(), outcome: QueryOutcome.cancelled, errorKind: null, returnedRows: null, wallTimeMs: 1 })
    expect(harness.store.getState().history.items.map(entry => entry.id)).toEqual(["h"])
  })

  it("appendHistory is best-effort: a failed append returns false and still refreshes the route", () => {
    const service = harness.registry.get<PersistenceServiceType>(TuiServiceId.persistence)
    jest.spyOn(harness.context.historyStore, "append").mockImplementationOnce(() => {
      throw new Error("disk full")
    })
    expect(service.appendHistory({ id: "h", profile: "p", query: "q", executedAt: new Date().toISOString(), outcome: QueryOutcome.cancelled, errorKind: null, returnedRows: null, wallTimeMs: 1 })).toBe(false)
    expect(harness.store.getState().history.items).toEqual([])
  })

  it("saves / removes queries and sets / removes default profiles through the shared stores", () => {
    const service = harness.registry.get<PersistenceServiceType>(TuiServiceId.persistence)
    service.saveQuery("first", "SELECT 1")
    expect(harness.store.getState().saved.items.map(saved => saved.name)).toEqual(["first"])
    service.removeSavedQuery("first")
    expect(harness.store.getState().saved.items).toEqual([])
    const profile = harness.context.profileStore.upsert({ name: "p", endpoint: "http://p.example" })
    service.setDefaultProfile(profile)
    expect(harness.store.getState().connection.defaultProfile).toBe("p")
    service.removeProfile(profile)
    expect(harness.store.getState().connection.profiles).toEqual([])
  })

  it("saves (adds / replaces by name) profiles and clears the history through the shared stores", () => {
    const service = harness.registry.get<PersistenceServiceType>(TuiServiceId.persistence)
    service.saveProfile({ name: "p", endpoint: "http://p.example", transportTimeoutMs: 5_000, retries: 1 })
    const saved = service.saveProfile({ name: "p", endpoint: "http://p.example", transportTimeoutMs: 7_000, queryTimeoutMs: 300, retries: 0 })
    expect(saved).toMatchObject({ transportTimeoutMs: 7_000, queryTimeoutMs: 300, retries: 0 })
    expect(harness.store.getState().connection.profiles).toEqual([saved])
    expect(harness.context.profileStore.get("p")).toEqual(saved)
    service.appendHistory({ id: "h", profile: "p", query: "q", executedAt: new Date().toISOString(), outcome: QueryOutcome.cancelled, errorKind: null, returnedRows: null, wallTimeMs: 1 })
    service.clearHistory()
    expect(harness.store.getState().history.items).toEqual([])
    expect(harness.context.historyStore.list()).toEqual([])
    service.clearHistory()
    expect(harness.store.getState().history.items).toEqual([])
  })

  it("reloads when another instance writes the files", async () => {
    harness.context.savedQueryStore.save("external", "SELECT 2")
    await waitFor(() => harness.store.getState().saved.items.length === 1)
    harness.context.profileStore.upsert({ name: "external", endpoint: "http://x.example" })
    await waitFor(() => harness.store.getState().connection.profiles.length === 1)
  })
})
