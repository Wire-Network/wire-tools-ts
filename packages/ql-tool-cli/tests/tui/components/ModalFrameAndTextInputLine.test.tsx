import { createTuiStore, ModalFrame, TextBuffer, TextInputLine, TuiColorRole, TuiPalette } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"

describe("ModalFrame", () => {
  it("frames a title, the body and the key hint in the brand border", () => {
    const renderer = renderTui(
        <ModalFrame title="Title" keysHint="Esc close">
          body
        </ModalFrame>,
        { store: createTuiStore() }
      ),
      [frame] = renderer.root.findAll(instance => String(instance.type) === "Box")
    expect(textOf(renderer)).toBe("Title\nbody\nEsc close")
    expect(frame.props).toMatchObject({ borderStyle: "double", borderColor: TuiPalette[TuiColorRole.brand] })
  })

  it("renders without a body", () => {
    expect(textOf(renderTui(<ModalFrame title="T" keysHint="k" />, { store: createTuiStore() }))).toBe("T\nk")
  })
})

describe("TextInputLine", () => {
  it("shows the text with the cursor inverse (code points), hidden when unfocused", () => {
    const buffer = TextBuffer.create("a😀b"),
      store = createTuiStore(),
      focused = renderTui(<TextInputLine buffer={{ ...buffer, cursor: 1 }} />, { store })
    expect(textsWithProp(focused, "inverse").map(instance => instance.props.children)).toEqual(["😀"])
    const blurred = renderTui(<TextInputLine buffer={buffer} focused={false} />, { store })
    expect(textOf(blurred)).toBe("a😀b")
    expect(textsWithProp(blurred, "inverse")).toEqual([])
  })

  it("puts the cursor past the end as a placeholder cell", () => {
    expect(textOf(renderTui(<TextInputLine buffer={TextBuffer.create("ab")} />, { store: createTuiStore() }))).toBe("ab ")
  })
})
