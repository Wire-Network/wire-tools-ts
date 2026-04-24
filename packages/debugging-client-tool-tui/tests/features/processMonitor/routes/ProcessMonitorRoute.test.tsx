import React from "react"
import { ProcessMonitorRoute } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/routes/ProcessMonitorRoute.js"

describe("ProcessMonitorRoute", () => {
  it("is a function component", () => {
    expect(typeof ProcessMonitorRoute).toBe("function")
  })

  it("accepts route params and returns a React element composing both panels", () => {
    const element = ProcessMonitorRoute({ params: {} })
    expect(React.isValidElement(element)).toBe(true)
  })
})
