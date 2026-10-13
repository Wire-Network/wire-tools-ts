import { identity } from "lodash"

import { createTuiStore, ListRoute, TuiRoute, TuiRouter, type QueryService, type TuiNavigation } from "@wireio/ql-tool-cli/tui/index.js"

import { press, renderTui, textOf } from "../../common/renderTui.js"

/** Render a list over three items on top of the workbench. */
function renderList(onCursorMoved = jest.fn(), onKey = jest.fn(), cursor = 1, isActive = true) {
  const renderer = renderTui(
    <ListRoute
      title="Things"
      emptyText="nothing"
      keysHint="hint"
      items={["a", "b", "c"]}
      cursor={cursor}
      itemKey={identity}
      rowText={item => `row ${item}`}
      onCursorMoved={onCursorMoved}
      onKey={onKey}
      isActive={isActive}
    />,
    { store: createTuiStore(), router: new TuiRouter([TuiRoute.workbench, TuiRoute.history]) }
  )
  return { renderer, onCursorMoved, onKey }
}

describe("ListRoute", () => {
  it("renders the header, title, rows (cursor inverse) and the hint", () => {
    const { renderer } = renderList(),
      inverse = renderer.root.findAll(instance => String(instance.type) === "Text" && instance.props.inverse === true)
    expect(textOf(renderer)).toContain("Things\nrow a\nrow b\nrow c\nhint")
    expect(inverse.map(instance => instance.props.children)).toEqual(["row b"])
  })

  it("shows the empty text without items", () => {
    const renderer = renderTui(
      <ListRoute title="T" emptyText="nothing" keysHint="h" items={[]} cursor={0} itemKey={String} rowText={String} onCursorMoved={jest.fn()} onKey={jest.fn()} />,
      { store: createTuiStore() }
    )
    expect(textOf(renderer)).toContain("T\nnothing\nh")
  })

  it("↑↓ move, other presses go to the route with the selected item, Esc pops", () => {
    const { renderer, onCursorMoved, onKey } = renderList()
    press("", { upArrow: true })
    press("", { downArrow: true })
    press("r")
    expect(onCursorMoved.mock.calls).toEqual([[-1], [1]])
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ input: "r" }), "b")
    expect(textOf(renderer)).toContain("· history")
    press("", { escape: true })
    expect(textOf(renderer)).toContain("· workbench")
  })

  it("an inactive list hears nothing", () => {
    const { onCursorMoved, onKey } = renderList(jest.fn(), jest.fn(), 0, false)
    press("", { downArrow: true })
    press("r")
    expect(onCursorMoved).not.toHaveBeenCalled()
    expect(onKey).not.toHaveBeenCalled()
  })

  it("loadQuery loads the editor, returns, and runs only when asked", () => {
    const dispatch = jest.fn(),
      navigation = { pop: jest.fn() } as unknown as TuiNavigation,
      query = { run: jest.fn(async () => undefined) } as unknown as QueryService
    ListRoute.loadQuery({ dispatch, navigation, query }, "SELECT 1", false)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: "SELECT 1" }))
    expect(navigation.pop).toHaveBeenCalledTimes(1)
    expect(query.run).not.toHaveBeenCalled()
    ListRoute.loadQuery({ dispatch, navigation, query }, "SELECT 2", true)
    expect(query.run).toHaveBeenCalledWith("SELECT 2")
  })

  it("keysHint wraps the route's parts in the move and back keys", () => {
    expect(ListRoute.keysHint(["Enter load"])).toBe("↑↓ move · Enter load · Esc back")
    expect(ListRoute.keysHint([])).toBe("↑↓ move · Esc back")
  })
})

describe("ListRoute hints", () => {
  it("derive ↑↓ and Enter from chords", () => {
    expect(ListRoute.MoveHint).toBe("↑↓ move")
    expect(ListRoute.LoadHint).toBe("Enter load")
  })
})
