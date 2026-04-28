import { LogViewerPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/process-monitor/panels/LogViewerPanel.js"

describe("LogViewerPanel", () => {
  it("has stable id/title metadata", () => {
    expect(LogViewerPanel.id).toBe("process-monitor:log-viewer")
    expect(LogViewerPanel.title).toBe("Log Viewer")
  })

  it("is a React function component", () => {
    expect(typeof LogViewerPanel).toBe("function")
  })

  it("declares its parent focus id so Esc can hand control back to the process list", () => {
    expect(LogViewerPanel.ParentFocusId).toBe("process-monitor:panel")
  })

  it("declares border style + colors used to frame the panel", () => {
    expect(LogViewerPanel.BorderStyle).toBe("round")
    expect(LogViewerPanel.BorderColorFocused).toBe("cyan")
    expect(LogViewerPanel.BorderColorUnfocused).toBe("gray")
  })

  it("ChromeLines accounts for the bordered chrome stack (App outer + compact list + log border + status)", () => {
    expect(LogViewerPanel.ChromeLines).toBe(18)
    expect(LogViewerPanel.SearchInputRows).toBe(2)
  })
})
