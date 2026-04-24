import { NodeCountWidget } from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/widgets/NodeCountWidget.js"

describe("NodeCountWidget", () => {
  it("has stable id metadata", () => {
    expect(NodeCountWidget.id).toBe("process-monitor:node-count")
  })

  it("is a React function component", () => {
    expect(typeof NodeCountWidget).toBe("function")
  })
})
