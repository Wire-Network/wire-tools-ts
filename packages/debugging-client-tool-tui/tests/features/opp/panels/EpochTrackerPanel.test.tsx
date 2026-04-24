import React from "react"
import { EpochTrackerPanel } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/panels/EpochTrackerPanel.js"

describe("EpochTrackerPanel", () => {
  it("has stable id/title metadata", () => {
    expect(EpochTrackerPanel.id).toBe("opp:epoch-tracker")
    expect(EpochTrackerPanel.title).toBe("OPP — Epoch Tracker")
  })

  it("is a React function component", () => {
    expect(typeof EpochTrackerPanel).toBe("function")
  })
})
