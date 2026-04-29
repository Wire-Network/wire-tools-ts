import {
  DefaultStatus,
  SliceName
} from "@wireio/debugging-client-tool-tui/store/StoreTypes.js"

describe("SliceName", () => {
  it("exposes a stable identity-mapped enum for every slice", () => {
    expect(SliceName.UI).toBe("ui")
    expect(SliceName.Cluster).toBe("cluster")
    expect(SliceName.Features).toBe("features")
    expect(SliceName.OPP).toBe("opp")
    expect(SliceName.ProcessMonitor).toBe("processMonitor")
  })

  it("is exhaustive — adding a new slice to the store requires adding it here too", () => {
    // Guards against drift: if a new slice is added to Store.ts reducer map,
    // the enum must grow or this test has to be updated in the same commit.
    expect(Object.keys(SliceName)).toHaveLength(5)
  })
})

describe("DefaultStatus", () => {
  it("is the initial status-string seed", () => {
    expect(DefaultStatus).toBe("idle")
  })
})
