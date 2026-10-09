import { findTab, nextActive } from "@wireio/ql-tool-app/renderer/store"

/** A three-tab strip carrying a payload beside the id. */
const Tabs = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
  { id: "c", title: "C" }
]

describe("findTab", () => {
  it("returns the tab itself (any shape with an id), or undefined for an unknown id", () => {
    expect(findTab(Tabs, "b")).toBe(Tabs[1])
    expect(findTab(Tabs, "missing")).toBeUndefined()
    expect(findTab([], "a")).toBeUndefined()
  })
})

describe("nextActive", () => {
  it("focuses the successor of the closed position, else the new last tab", () => {
    expect(nextActive(Tabs, 1)).toBe("b")
    expect(nextActive(Tabs, 3)).toBe("c")
  })

  it("is undefined when no tab remains", () => {
    expect(nextActive([], 0)).toBeUndefined()
  })
})
