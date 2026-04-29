import { EpochStatusBarWidget } from "@wireio/debugging-client-tool-tui/features/opp/widgets/EpochStatusBarWidget.js"

describe("EpochStatusBarWidget", () => {
  it("has stable id metadata", () => {
    expect(EpochStatusBarWidget.id).toBe("opp:epoch-status-bar-widget")
  })

  it("is a React function component", () => {
    expect(typeof EpochStatusBarWidget).toBe("function")
  })
})
