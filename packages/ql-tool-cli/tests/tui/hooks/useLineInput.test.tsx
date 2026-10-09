import { act } from "react"
import TestRenderer from "react-test-renderer"

import { useLineInput, type LineInput, type LineInputOptions } from "@wireio/ql-tool-cli/tui/index.js"

import { press } from "../../common/renderTui.js"

/** Props of the test input. */
interface InputProps {
  options: LineInputOptions
  onRender(input: LineInput): void
}

/** Exposes the hook's state on every render. */
function Input({ options, onRender }: InputProps) {
  onRender(useLineInput("ab", options))
  return null
}

describe("useLineInput", () => {
  let renderer: TestRenderer.ReactTestRenderer = null
  afterEach(() => act(() => renderer?.unmount()))

  /** Mount the input; returns the latest render's state accessor. */
  function mount(options: LineInputOptions): () => LineInput {
    let latest: LineInput = null
    act(() => {
      renderer = TestRenderer.create(<Input options={options} onRender={input => (latest = input)} />)
    })
    return () => latest
  }

  it("edits the line and submits its text on Enter", () => {
    const onSubmit = jest.fn(),
      onCancel = jest.fn(),
      input = mount({ onSubmit, onCancel })
    press("c")
    press("", { backspace: true })
    press("x")
    expect(input().buffer.text).toBe("abx")
    press("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("abx")
    press("", { escape: true })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("offers other presses to onKey first; a consumed press never edits", () => {
    const onKey = jest.fn(event => event.input === "q"),
      input = mount({ onSubmit: jest.fn(), onCancel: jest.fn(), onKey })
    press("q")
    press("z")
    expect(onKey).toHaveBeenCalledTimes(2)
    expect(input().buffer.text).toBe("abz")
    act(() => input().replace("new"))
    expect(input().buffer.text).toBe("new")
  })

  it("an inactive input hears nothing", () => {
    const onSubmit = jest.fn(),
      input = mount({ onSubmit, onCancel: jest.fn(), isActive: false })
    press("x")
    press("", { return: true })
    expect(input().buffer.text).toBe("ab")
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
