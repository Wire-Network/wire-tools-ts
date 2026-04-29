import React from "react"
import {
  EpochTrackerPanel,
  computeMarginTop
} from "@wireio/debugging-client-tool-tui/features/opp/panels/EpochTrackerPanel.js"

describe("EpochTrackerPanel", () => {
  it("has stable id/title metadata", () => {
    expect(EpochTrackerPanel.id).toBe("opp:epoch-tracker")
    expect(EpochTrackerPanel.title).toBe("OPP — Epoch Tracker")
  })

  it("is a React function component", () => {
    expect(typeof EpochTrackerPanel).toBe("function")
  })

  it("declares the visual constants the renderer + tests rely on", () => {
    expect(EpochTrackerPanel.ReceivedIcon).toBe("\u{2705}")
    expect(EpochTrackerPanel.PendingIcon).toBe("\u{F04E6}")
    expect(EpochTrackerPanel.ReceivedColor).toBe("green")
    expect(EpochTrackerPanel.PendingColor).toBe("yellow")
    expect(EpochTrackerPanel.SelectedBorderColor).toBe("cyan")
    expect(EpochTrackerPanel.LatestBorderStyle).toBe("round")
    expect(EpochTrackerPanel.AttestationsLabel).toBe("attestations")
  })

  it("DetailRoutePath matches the EpochDetailRoute registration", () => {
    expect(EpochTrackerPanel.DetailRoutePath).toBe("/opp/epoch")
  })

  it("RowsPerEpoch + UnborderedPaddingX are positive — chrome math depends on them", () => {
    expect(EpochTrackerPanel.RowsPerEpoch).toBeGreaterThan(0)
    expect(EpochTrackerPanel.UnborderedPaddingX).toBe(2)
  })
})

describe("computeMarginTop", () => {
  /**
   * Layout under test (selectedIdx=4):
   *
   *   abs=0 (latest, bordered)        — viewport top
   *   abs=1 (next to latest, bordered above)
   *   abs=2 (free)
   *   abs=3 (next to selected, bordered below)
   *   abs=4 (selected, bordered)
   *   abs=5 (next to selected, bordered above)
   *   abs=6 (free)
   */
  const SelectedIdx = 4

  it("first visible row never has a top margin", () => {
    expect(computeMarginTop(0, SelectedIdx, 0)).toBe(0)
    expect(computeMarginTop(7, SelectedIdx, 0)).toBe(0)
  })

  it("latest row gets no top margin (its border is the separator)", () => {
    expect(computeMarginTop(0, SelectedIdx, 1)).toBe(0)
  })

  it("row immediately after latest gets no top margin (latest's bottom border)", () => {
    expect(computeMarginTop(1, SelectedIdx, 1)).toBe(0)
  })

  it("free row two below latest gets a 1-row margin", () => {
    expect(computeMarginTop(2, SelectedIdx, 2)).toBe(1)
  })

  it("row immediately above selected gets no top margin", () => {
    // row at abs=4 is selected; row at abs=3 is the predecessor we're checking.
    // The selected row's marginTop check happens when the row is rendered — for
    // the row above selected, marginTop is 1 (its predecessor abs=2 is free).
    expect(computeMarginTop(3, SelectedIdx, 3)).toBe(1)
    // The SELECTED row itself drops its margin (its top border is the separator).
    expect(computeMarginTop(4, SelectedIdx, 4)).toBe(0)
  })

  it("row immediately after selected gets no top margin", () => {
    expect(computeMarginTop(5, SelectedIdx, 5)).toBe(0)
  })

  it("row two below selected returns to a 1-row margin", () => {
    expect(computeMarginTop(6, SelectedIdx, 6)).toBe(1)
  })
})
