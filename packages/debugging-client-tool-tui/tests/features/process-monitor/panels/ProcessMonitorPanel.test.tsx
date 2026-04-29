import { ProcessMonitorPanel } from "@wireio/debugging-client-tool-tui/features/process-monitor/panels/ProcessMonitorPanel.js"

describe("ProcessMonitorPanel", () => {
  it("has stable id/title metadata", () => {
    expect(ProcessMonitorPanel.id).toBe("process-monitor:panel")
    expect(ProcessMonitorPanel.title).toBe("Process Monitor")
  })

  it("is a React function component", () => {
    expect(typeof ProcessMonitorPanel).toBe("function")
  })

  it("compact-row count keeps the panel ≤ 5 lines (1 header + 4 rows)", () => {
    expect(ProcessMonitorPanel.CompactRowCount).toBe(4)
  })
})
