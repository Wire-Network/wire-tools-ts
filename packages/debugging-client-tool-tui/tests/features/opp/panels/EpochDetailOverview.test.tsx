import { EpochDetailOverview } from "@wireio/debugging-client-tool-tui/features/opp/panels/EpochDetailOverview.js"

describe("EpochDetailOverview", () => {
  it("declares its layout + label constants", () => {
    expect(EpochDetailOverview.UnreceivedLabel).toBe("unreceived")
    expect(EpochDetailOverview.MissingEpochText).toMatch(/Esc/)
    expect(EpochDetailOverview.EndpointLabelWidth).toBeGreaterThan(0)
    expect(EpochDetailOverview.MetadataIndent).toBeGreaterThanOrEqual(0)
  })

  it("is a React function component", () => {
    expect(typeof EpochDetailOverview).toBe("function")
  })
})
