import { App } from "@wireio/ql-tool-cli/tui/index.js"

import { inkMock, press, renderTui, textOf } from "../common/renderTui.js"
import { useStubEngine } from "../common/stubEngine.js"
import { idle, startTuiHarness, type TuiHarness } from "../common/tuiHarness.js"

describe("App", () => {
  let harness: TuiHarness

  const engine = useStubEngine()

  beforeEach(async () => {
    harness = await startTuiHarness(engine().endpoint)
  })

  afterEach(() => harness.registry.stopAll())

  it("routes between the workbench and help, and quits on Ctrl+C after the in-flight run settles", async () => {
    const renderer = renderTui(<App store={harness.store} registry={harness.registry} />, { store: harness.store })
    expect(textOf(renderer)).toContain("Query")
    press("?", { meta: true })
    expect(textOf(renderer)).toContain("Ctrl+R  run the query")
    press("", { escape: true })
    expect(textOf(renderer)).toContain("Query")
    press("c", { ctrl: true })
    await idle(harness)
    expect(inkMock().__exit).toHaveBeenCalled()
  })

  it("maps every route to a component", () => {
    expect(Object.keys(App.Routes).sort()).toEqual(["help", "history", "profiles", "saved", "workbench"])
  })
})
