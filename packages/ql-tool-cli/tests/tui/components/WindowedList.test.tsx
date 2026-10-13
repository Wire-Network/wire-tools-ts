import { Text } from "ink"

import { ResultView } from "@wireio/ql-shared"

import { createTuiStore, WindowedList } from "@wireio/ql-tool-cli/tui/index.js"

import { createResult, column, sampleResult } from "../../common/engineFixtures.js"
import { renderTui, textOf } from "../../common/renderTui.js"

describe("WindowedList", () => {
  const view = ResultView.create(sampleResult()),
    render = (offset: number, height: number, target = view) =>
      textOf(
        renderTui(<WindowedList view={target} offset={offset} height={height} renderRow={(row, index) => <Text>{`${index}:${row.name}`}</Text>} />, {
          store: createTuiStore()
        })
      )

  it("renders exactly rows [offset, offset + height)", () => {
    expect(render(1, 1)).toBe("1:bob")
    expect(render(0, 2)).toBe("0:alice\n1:bob")
  })

  it("clamps an offset past the end and shows the empty state", () => {
    expect(render(99, 2)).toBe("1:bob\n2:carol")
    expect(render(0, 3, ResultView.create(createResult([column("name")], [])))).toBe(WindowedList.DefaultEmptyText)
  })

  it("window math keeps the cursor visible", () => {
    expect(WindowedList.offsetFor(0, 5, 100)).toBe(0)
    expect(WindowedList.offsetFor(50, 10, 100)).toBe(45)
    expect(WindowedList.offsetFor(99, 10, 100)).toBe(90)
    expect(WindowedList.clampOffset(-3, 4, 2)).toBe(0)
    expect(WindowedList.window(["a", "b", "c", "d"], 3, 2)).toEqual({ offset: 2, items: ["c", "d"] })
  })
})
