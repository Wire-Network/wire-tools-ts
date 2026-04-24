import { ProcessMonitorPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/panels/ProcessMonitorPanel.js"

describe("ProcessMonitorPanel", () => {
  it("has stable id/title metadata", () => {
    expect(ProcessMonitorPanel.id).toBe("process-monitor:panel")
    expect(ProcessMonitorPanel.title).toBe("Process Monitor")
  })

  it("is a React function component", () => {
    expect(typeof ProcessMonitorPanel).toBe("function")
  })
})
