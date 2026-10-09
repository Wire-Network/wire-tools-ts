import { act, type ReactElement } from "react"

import { QueryOutcome } from "@wireio/ql-shared"

import {
  HelpRoute,
  HistoryActions,
  HistoryRoute,
  KeyBindings,
  ProfilesRoute,
  SavedQueriesRoute,
  TuiRoute,
  TuiRouter,
  TuiServiceId,
  type PersistenceService
} from "@wireio/ql-tool-cli/tui/index.js"

import { press, renderTui, textOf } from "../../common/renderTui.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { idle, startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"

describe("list routes", () => {
  let harness: TuiHarness

  const engine = useStubEngine()

  beforeEach(async () => {
    engine().requests.length = 0
    harness = await startTuiHarness(engine().endpoint)
  })

  afterEach(() => harness.registry.stopAll())

  const render = (route: TuiRoute, element: ReactElement) =>
    renderTui(element, { store: harness.store, registry: harness.registry, router: new TuiRouter([TuiRoute.workbench, route]) })

  it("Profiles: move, default, switch (Enter), remove; empty state", () => {
    const persistence = harness.registry.get<PersistenceService>(TuiServiceId.persistence),
      renderer = render(TuiRoute.profiles, <ProfilesRoute />)
    expect(textOf(renderer)).toContain(ProfilesRoute.EmptyText)
    act(() => {
      harness.context.profileStore.upsert({ name: "one", endpoint: engine().endpoint })
      harness.context.profileStore.upsert({ name: "two", endpoint: engine().endpoint })
      persistence.setDefaultProfile(harness.context.profileStore.get("one"))
    })
    press("", { downArrow: true })
    press("d")
    expect(harness.store.getState().connection.defaultProfile).toBe("two")
    press("", { return: true })
    expect(harness.store.getState().connection.profile.name).toBe("two")
    press("x")
    expect(harness.store.getState().connection.profiles.map(profile => profile.name)).toEqual(["one"])
    press("", { upArrow: true })
    press("", { escape: true })
  })

  it("Profiles: rows show the tuning; a adds, e edits (an edit of the active profile reconnects)", () => {
    const renderer = render(TuiRoute.profiles, <ProfilesRoute />)
    press("a")
    expect(textOf(renderer)).toContain(ProfilesRoute.AddTitle)
    Array.from("mine").forEach(character => press(character))
    press("", { tab: true })
    Array.from(engine().endpoint).forEach(character => press(character))
    press("", { return: true })
    expect(harness.context.profileStore.get("mine")).toMatchObject({ endpoint: engine().endpoint, transportTimeoutMs: 10_000, retries: 2 })
    expect(textOf(renderer)).toContain("mine")
    expect(textOf(renderer)).toContain(`transport 10000 ms · server ${ProfilesRoute.ServerDefaultText} · retries 2`)
    press("", { return: true })
    expect(harness.store.getState().connection.profile.name).toBe("mine")
    const edited = render(TuiRoute.profiles, <ProfilesRoute />)
    press("e")
    expect(textOf(edited)).toContain(`${ProfilesRoute.EditTitle} mine`)
    ;[0, 1, 2].forEach(() => press("", { downArrow: true }))
    Array.from("400").forEach(character => press(character))
    press("", { return: true })
    expect(harness.context.profileStore.get("mine").queryTimeoutMs).toBe(400)
    expect(harness.store.getState().connection.profile.queryTimeoutMs).toBe(400)
    expect(harness.store.getState().ui.messages.at(-1).text).toContain("connected to mine")
    press("e")
    press("", { escape: true })
    expect(textOf(edited)).not.toContain(ProfilesRoute.EditTitle)
    press("", { escape: true })
  })

  it("Profiles: saving a non-active profile reports it; rowText marks default / active and owners", () => {
    render(TuiRoute.profiles, <ProfilesRoute />)
    press("a")
    Array.from("other").forEach(character => press(character))
    press("", { tab: true })
    Array.from(engine().endpoint).forEach(character => press(character))
    press("", { return: true })
    expect(harness.store.getState().ui.messages.at(-1).text).toBe("saved profile other")
    const profile = { name: "p", endpoint: "http://p.example", transportTimeoutMs: 5, queryTimeoutMs: 7, retries: 1, owners: ["a", "b"] }
    expect(ProfilesRoute.rowText(profile, "p", "p")).toBe("* > p  http://p.example · transport 5 ms · server 7 ms · retries 1 · owners a,b")
    expect(ProfilesRoute.rowText({ ...profile, owners: undefined }, null, "q")).toBe("    p  http://p.example · transport 5 ms · server 7 ms · retries 1")
    press("", { escape: true })
  })

  it("History: c asks to clear; yes clears the shared history, anything else keeps it", () => {
    const persistence = harness.registry.get<PersistenceService>(TuiServiceId.persistence),
      entry = { id: "h1", profile: "p", query: "SELECT 7", executedAt: new Date().toISOString(), outcome: QueryOutcome.success, errorKind: null, returnedRows: 1, wallTimeMs: 1 }
    act(() => persistence.appendHistory(entry))
    const renderer = render(TuiRoute.history, <HistoryRoute />)
    press("c")
    expect(textOf(renderer)).toContain(HistoryRoute.ClearConfirmTitle)
    press("n")
    press("", { return: true })
    expect(harness.context.historyStore.list()).toHaveLength(1)
    expect(harness.store.getState().ui.messages.at(-1).text).toBe("history kept")
    press("c")
    press("", { escape: true })
    expect(textOf(renderer)).not.toContain(HistoryRoute.ClearConfirmTitle)
    expect(harness.context.historyStore.list()).toHaveLength(1)
    press("c")
    Array.from(" YES ").forEach(character => press(character))
    press("", { return: true })
    expect(harness.context.historyStore.list()).toEqual([])
    expect(harness.store.getState().history.items).toEqual([])
    expect(harness.store.getState().ui.messages.at(-1).text).toBe("history cleared")
    expect(textOf(renderer)).toContain(HistoryRoute.EmptyText)
    press("", { escape: true })
  })

  it("History: Enter loads, r reruns", async () => {
    const entry = { id: "h1", profile: "p", query: "SELECT 7", executedAt: new Date().toISOString(), outcome: QueryOutcome.success, errorKind: null, returnedRows: 1, wallTimeMs: 1 }
    act(() => void harness.store.dispatch(HistoryActions.itemsLoaded([entry])))
    const renderer = render(TuiRoute.history, <HistoryRoute />)
    expect(textOf(renderer)).toContain("SELECT 7")
    press("", { return: true })
    expect(harness.store.getState().editor.buffer.text).toBe("SELECT 7")
    render(TuiRoute.history, <HistoryRoute />)
    press("", { downArrow: true })
    press("r")
    await idle(harness)
    expect(engine().requests.at(-1).params.query).toBe("SELECT 7")
    render(TuiRoute.history, <HistoryRoute />)
    press("", { escape: true })
  })

  it("Saved: Enter loads, r runs, x removes; empty state", async () => {
    const persistence = harness.registry.get<PersistenceService>(TuiServiceId.persistence),
      renderer = render(TuiRoute.saved, <SavedQueriesRoute />)
    expect(textOf(renderer)).toContain(SavedQueriesRoute.EmptyText)
    act(() => void persistence.saveQuery("mine", "SELECT 8"))
    press("", { return: true })
    expect(harness.store.getState().editor.buffer.text).toBe("SELECT 8")
    render(TuiRoute.saved, <SavedQueriesRoute />)
    press("r")
    await idle(harness)
    expect(engine().requests.at(-1).params.query).toBe("SELECT 8")
    render(TuiRoute.saved, <SavedQueriesRoute />)
    press("x")
    expect(harness.store.getState().saved.items).toEqual([])
    press("", { escape: true })
  })

  it("Help lists every binding by scope", () => {
    const text = textOf(render(TuiRoute.help, <HelpRoute />))
    KeyBindings.Defaults.forEach(binding => expect(text).toContain(binding.describe))
    press("", { escape: true })
  })
})

describe("list route messages and hints", () => {
  it("History / Saved / Profiles hints spell Enter from its chord", () => {
    expect(HistoryRoute.KeysHint).toBe("↑↓ move · Enter load · r rerun · c clear · Esc back")
    expect(SavedQueriesRoute.KeysHint).toBe("↑↓ move · Enter load · r run · x remove · Esc back")
    expect(ProfilesRoute.KeysHint).toBe("↑↓ move · Enter use · a add · e edit · d default · x remove · Esc back")
    expect(HistoryRoute.ClearConfirmHint).toBe("type yes and Enter to clear; anything else keeps it")
  })

  it("HistoryRoute.KeptText and ProfilesRoute.connectedText", () => {
    expect(HistoryRoute.KeptText).toBe("history kept")
    expect(ProfilesRoute.connectedText({ name: "p", endpoint: "http://p.example", transportTimeoutMs: 1, retries: 0 })).toBe(
      "connected to p (http://p.example)"
    )
  })
})
