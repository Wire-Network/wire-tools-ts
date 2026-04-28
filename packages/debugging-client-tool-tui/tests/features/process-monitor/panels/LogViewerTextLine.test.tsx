import React from "react"
import { LogViewerTextLine } from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/panels/LogViewerTextLine.js"

describe("LogViewerTextLine", () => {
  it("is a React function component", () => {
    expect(typeof LogViewerTextLine).toBe("function")
  })

  it("renders the raw line verbatim when no offset / highlight is set", () => {
    const element = LogViewerTextLine({
      line: "INFO: launching nodeop",
      horizontalOffset: 0,
      highlight: ""
    })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain("INFO: launching nodeop")
  })

  it("slices the line by horizontalOffset", () => {
    const element = LogViewerTextLine({
      line: "INFO: launching nodeop",
      horizontalOffset: 6, // drops "INFO: "
      highlight: ""
    })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain("launching nodeop")
    expect(serialized).not.toContain("INFO:")
  })

  it("highlights search matches case-insensitively", () => {
    const element = LogViewerTextLine({
      line: "INFO: launching NODEOP",
      horizontalOffset: 0,
      highlight: "nodeop"
    })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain('"inverse":true')
    expect(serialized).toContain("NODEOP")
  })

  it("renders with truncate-end wrap mode (no wrap → no overdraw)", () => {
    const element = LogViewerTextLine({
      line: "INFO: launching nodeop",
      horizontalOffset: 0,
      highlight: ""
    })
    expect((element.props as { wrap?: string }).wrap).toBe("truncate-end")
  })
})
