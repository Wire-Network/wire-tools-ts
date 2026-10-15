import { QLBrand } from "@wireio/ql-shared"

import { ConnectionBar, createTuiStore, HeaderBar, KeyBindings, ResultsActions, TuiAction, TuiRoute, TuiRouter } from "@wireio/ql-tool-cli/tui/index.js"

import { sampleResult, successExecution } from "../../common/engineFixtures.js"

import { renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("HeaderBar", () => {
  it("shows WIRE QL in the brand color, the route and the help hint", () => {
    const renderer = renderTui(<HeaderBar />, { store: createTuiStore(), router: new TuiRouter([TuiRoute.workbench, TuiRoute.history]) })
    expect(textOf(renderer)).toBe(`${QLBrand.ProductName} · history\n${HeaderBar.HelpHint}`)
    expect(renderer.root.findAll(instance => instance.props.color === QLBrand.PrimaryHex).length).toBeGreaterThan(0)
  })

  it("derives the help hint from the bindings", () => {
    expect(HeaderBar.HelpHint).toBe(`${KeyBindings.labelOf(TuiAction.help)} help · ${KeyBindings.labelOf(TuiAction.quit)} quit`)
  })
})

describe("ConnectionBar", () => {
  it("shows profile, endpoint and the last snapshot (chain, head, LIB, read mode, sync)", () => {
    expect(textOf(renderTui(<ConnectionBar />, { store: storeWithResult() }))).toBe(
      "local · http://node.example · chain aaaaaaaaaaaa · head 42 · LIB 40 · head · synced"
    )
  })

  it("labels a node that is not synced", () => {
    const store = storeWithResult(successExecution(sampleResult()))
    store.dispatch(ResultsActions.runFinished(successExecution({ ...sampleResult(), state: { ...sampleResult().state, synced: false } })))
    expect(textOf(renderTui(<ConnectionBar />, { store }))).toMatch(/ · NOT synced$/)
  })

  it("marks unknowns before the first query", () => {
    expect(textOf(renderTui(<ConnectionBar />, { store: createTuiStore() }))).toBe("? · ? · chain ?")
  })
})
