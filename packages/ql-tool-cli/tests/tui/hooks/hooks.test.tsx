import { act } from "react"
import { useInput, useWindowSize } from "ink"
import TestRenderer from "react-test-renderer"

import { KeyScope, TerminalSize, TuiAction, useTerminalSize, useTuiKeys, type TuiKeyEvent } from "@wireio/ql-tool-cli/tui/index.js"

import { inkMock, press } from "../../common/renderTui.js"

/** Props of the test listener. */
interface ListenerProps {
  active: boolean
}

describe("useTuiKeys", () => {
  it("resolves presses in the scope and passes raw input along; inactive handlers hear nothing", () => {
    const events: TuiKeyEvent[] = []
    /** Listens in the grid scope. */
    function Listener({ active }: ListenerProps) {
      useTuiKeys(KeyScope.grid, event => events.push(event), active)
      return null
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<Listener active />)
    })
    press("s")
    press("x")
    expect(events.map(event => [event.action, event.input])).toEqual([[TuiAction.sortColumn, "s"], [TuiAction.none, "x"]])
    act(() => renderer.update(<Listener active={false} />))
    expect(inkMock().__handlerCount()).toBe(0)
    expect(useInput).toHaveBeenLastCalledWith(expect.any(Function), { isActive: false })
  })
})

describe("useTerminalSize", () => {
  it("derives the layout from Ink's window size and follows a resize", () => {
    const sizes: TerminalSize[] = []
    /** Records the size. */
    function Reader() {
      sizes.push(useTerminalSize())
      return null
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<Reader />)
    })
    ;(useWindowSize as jest.Mock).mockReturnValueOnce({ columns: 60, rows: 10 })
    act(() => renderer.update(<Reader />))
    expect(sizes[0]).toEqual(TerminalSize.layout(120, 40))
    expect(sizes.at(-1)).toMatchObject({ columns: 60, rows: 10, schemaWidth: TerminalSize.MinimumSchemaWidth, resultsHeight: TerminalSize.MinimumResultsRows })
  })
})
