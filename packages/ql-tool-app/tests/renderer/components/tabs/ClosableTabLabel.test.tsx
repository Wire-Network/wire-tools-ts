/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { ClosableTabLabel } from "@wireio/ql-tool-app/renderer/components"

describe("ClosableTabLabel", () => {
  it("renders the title, the extra actions and Close last, each a focusable button", () => {
    const onClose = jest.fn(),
      onPin = jest.fn(),
      onParentClick = jest.fn()
    render(
      <div onClick={onParentClick}>
        <ClosableTabLabel title="Result 1" closeLabel="Close Result 1" onClose={onClose} actions={[{ label: "Pin Result 1", icon: <span>p</span>, onAction: onPin }]} />
      </div>
    )
    const buttons = screen.getAllByRole("button")
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["Pin Result 1", "Close Result 1"])
    buttons.forEach(button => expect(button.tabIndex).toBe(0))
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    expect(onPin).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onParentClick).not.toHaveBeenCalled()
    expect(screen.getByText("Result 1")).toBeInTheDocument()
  })

  it("Enter on a focused button activates it (keyboard reachable)", () => {
    const onClose = jest.fn()
    render(<ClosableTabLabel title="Query 1" closeLabel="Close Query 1" onClose={onClose} />)
    const close = screen.getByRole("button", { name: "Close Query 1" })
    close.focus()
    fireEvent.keyDown(close, { key: "Enter" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
