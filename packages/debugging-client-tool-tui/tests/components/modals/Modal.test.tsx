import React from "react"
import { Modal } from "@wireio/debugging-client-tool-tui/components/modals/Modal.js"

describe("Modal", () => {
  it("is a function component", () => {
    expect(typeof Modal).toBe("function")
  })

  it("renders a React element with the given title + children", () => {
    const element = Modal({
      title: "Hello",
      children: React.createElement("span", null, "world")
    })
    expect(React.isValidElement(element)).toBe(true)
    // Smoke: title prop made it through (rendered inside the element tree).
    const serialized = JSON.stringify(element)
    expect(serialized).toContain("Hello")
  })

  it("accepts an optional borderColor", () => {
    const element = Modal({
      title: "Destructive",
      borderColor: "red",
      children: null
    })
    expect(React.isValidElement(element)).toBe(true)
  })
})
