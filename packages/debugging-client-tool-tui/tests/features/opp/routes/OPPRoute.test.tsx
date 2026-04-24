import React from "react"
import { OPPRoute } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/routes/OPPRoute.js"

describe("OPPRoute", () => {
  it("is a function component", () => {
    expect(typeof OPPRoute).toBe("function")
  })

  it("accepts route params and returns a React element", () => {
    const element = OPPRoute({ params: {} })
    expect(React.isValidElement(element)).toBe(true)
  })
})
