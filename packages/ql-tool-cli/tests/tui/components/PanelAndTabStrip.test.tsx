import { Text } from "ink"

import { QLBrand } from "@wireio/ql-shared"

import { createTuiStore, Panel, ResultsTab, TabStrip } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"

describe("Panel", () => {
  it("renders the title and content, brand border when focused", () => {
    const focused = renderTui(<Panel title="Schema" focused><Text>body</Text></Panel>, { store: createTuiStore() })
    expect(textOf(focused)).toBe("Schema\nbody")
    expect(focused.root.findByType("Box" as never).props.borderColor).toBe(QLBrand.PrimaryHex)
    const plain = renderTui(<Panel title="Schema" />, { store: createTuiStore() })
    expect(plain.root.findByType("Box" as never).props.borderColor).toBe("gray")
  })
})

describe("TabStrip", () => {
  it("renders every label and marks the active one", () => {
    const renderer = renderTui(
      <TabStrip tabs={[{ key: ResultsTab.grid, label: "Grid" }, { key: ResultsTab.json, label: "JSON" }]} active={ResultsTab.json} />,
      { store: createTuiStore() }
    )
    expect(textOf(renderer)).toBe(" Grid \n JSON ")
    expect(textsWithProp(renderer, "inverse").map(instance => instance.props.children)).toEqual([" JSON "])
  })

  it("renders nothing for no tabs", () => {
    expect(textOf(renderTui(<TabStrip tabs={[]} active={ResultsTab.grid} />, { store: createTuiStore() }))).toBe("")
  })
})
