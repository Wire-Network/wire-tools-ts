import { CatalogActions, createTuiStore, SchemaTreePanel } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"

describe("SchemaTreePanel", () => {
  const snapshot = {
    endpoint: "http://node.example",
    capturedAt: new Date().toISOString(),
    owners: [{ account: "sample", loaded: true, tables: [{ name: "positions", rowType: "position", described: false, fields: [] }] }]
  }

  it("lists the tree with the cursor when focused", () => {
    const store = createTuiStore()
    store.dispatch(CatalogActions.snapshotLoaded(snapshot))
    store.dispatch(CatalogActions.nodeToggled("sample"))
    const renderer = renderTui(<SchemaTreePanel focused width={30} height={5} />, { store })
    expect(textOf(renderer)).toBe("Schema\nsample\n  positions")
    expect(textsWithProp(renderer, "inverse").map(instance => instance.props.children)).toEqual(["sample"])
  })

  it("shows loading and errors; no cursor when unfocused", () => {
    const store = createTuiStore()
    store.dispatch(CatalogActions.loadStarted())
    store.dispatch(CatalogActions.loadFinished("could not load: x"))
    store.dispatch(CatalogActions.loadStarted())
    const renderer = renderTui(<SchemaTreePanel focused={false} width={30} height={5} />, { store })
    expect(textOf(renderer)).toBe(`Schema\n${SchemaTreePanel.LoadingText}`)
  })
})

describe("SchemaTreePanel keys", () => {
  it("names its describe input and derives its hints from chords", () => {
    expect(SchemaTreePanel.DescribeInput).toBe("d")
    expect(SchemaTreePanel.KeysHint).toBe("↑↓ move · Enter expand/insert · d describe")
    expect(SchemaTreePanel.KeysLabel).toBe("↑↓ Enter → d")
  })
})
