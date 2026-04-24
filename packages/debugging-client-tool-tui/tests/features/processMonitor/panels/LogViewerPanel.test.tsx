import { LogViewerPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/panels/LogViewerPanel.js"

describe("LogViewerPanel", () => {
  it("has stable id/title metadata", () => {
    expect(LogViewerPanel.id).toBe("process-monitor:log-viewer")
    expect(LogViewerPanel.title).toBe("Log Viewer")
  })

  it("is a React function component", () => {
    expect(typeof LogViewerPanel).toBe("function")
  })
})
