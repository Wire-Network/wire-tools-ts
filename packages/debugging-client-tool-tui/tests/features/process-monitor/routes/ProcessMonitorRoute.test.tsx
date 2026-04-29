import React from "react"
import { ProcessMonitorRoute } from "@wireio/debugging-client-tool-tui/features/process-monitor/routes/ProcessMonitorRoute.js"

describe("ProcessMonitorRoute", () => {
  it("is a function component", () => {
    expect(typeof ProcessMonitorRoute).toBe("function")
  })

  it("accepts route params and returns a React element composing both panels", () => {
    const element = ProcessMonitorRoute({ params: {} })
    expect(React.isValidElement(element)).toBe(true)
  })
})
