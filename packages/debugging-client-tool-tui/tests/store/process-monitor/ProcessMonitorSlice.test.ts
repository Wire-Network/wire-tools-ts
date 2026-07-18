import {
  processMonitorSlice,
  removeProcess,
  setLogViewerFollow,
  setLogViewerHorizontalOffset,
  setLogViewerOffset,
  setLogViewerPath,
  setProcess,
  setSearchActive,
  setSearchQuery,
  toggleLocationColumn
} from "@wireio/debugging-client-tool-tui/store/process-monitor/ProcessMonitorSlice.js"
import type { ProcessLivenessSnapshot } from "@wireio/debugging-shared"
import {
  selectAliveCount,
  selectLogViewer,
  selectProcessMap,
  selectProcessMonitor,
  selectTotalCount
} from "@wireio/debugging-client-tool-tui/store/process-monitor/ProcessMonitorSelectors.js"
import { SliceName } from "@wireio/debugging-client-tool-tui/store/StoreTypes.js"

function mkLiveness(
  label: string,
  alive: boolean,
  pid: number | null = 1
): ProcessLivenessSnapshot {
  return { label, pid, alive, lastCheckedAt: 0, exitedAt: alive ? null : 0 }
}

describe("processMonitorSlice", () => {
  it("initial state: empty map + default viewer", () => {
    const state = processMonitorSlice.reducer(undefined, { type: "@@init" })
    expect(state.processes).toEqual({})
    expect(state.logViewer).toEqual({
      path: null,
      offset: 0,
      follow: true,
      horizontalOffset: 0,
      searchActive: false,
      searchQuery: "",
      locationVisible: false
    })
  })

  it("setProcess / removeProcess round-trip", () => {
    const afterSet = processMonitorSlice.reducer(
      undefined,
      setProcess(mkLiveness("node-00", true))
    )
    expect(afterSet.processes["node-00"].alive).toBe(true)
    const afterRemove = processMonitorSlice.reducer(
      afterSet,
      removeProcess("node-00")
    )
    expect(afterRemove.processes["node-00"]).toBeUndefined()
  })

  it("setLogViewerPath resets per-file viewer fields but keeps locationVisible sticky", () => {
    let state = processMonitorSlice.reducer(undefined, setLogViewerOffset(100))
    state = processMonitorSlice.reducer(state, setLogViewerHorizontalOffset(40))
    state = processMonitorSlice.reducer(state, setSearchActive(true))
    state = processMonitorSlice.reducer(state, setSearchQuery("foo"))
    state = processMonitorSlice.reducer(state, toggleLocationColumn())
    expect(state.logViewer.offset).toBe(100)
    expect(state.logViewer.horizontalOffset).toBe(40)
    expect(state.logViewer.searchActive).toBe(true)
    expect(state.logViewer.searchQuery).toBe("foo")
    expect(state.logViewer.locationVisible).toBe(true)

    const switched = processMonitorSlice.reducer(
      state,
      setLogViewerPath("/tmp/log")
    )
    expect(switched.logViewer).toEqual({
      path: "/tmp/log",
      offset: 0,
      follow: true,
      horizontalOffset: 0,
      searchActive: false,
      searchQuery: "",
      // sticky — preserved from before the path switch.
      locationVisible: true
    })
  })

  it("setLogViewerOffset clamps negative to 0 and disables follow", () => {
    const state = processMonitorSlice.reducer(
      undefined,
      setLogViewerOffset(-50)
    )
    expect(state.logViewer.offset).toBe(0)
    expect(state.logViewer.follow).toBe(false)
  })

  it("setLogViewerFollow toggles the flag", () => {
    const off = processMonitorSlice.reducer(
      undefined,
      setLogViewerFollow(false)
    )
    expect(off.logViewer.follow).toBe(false)
    const on = processMonitorSlice.reducer(off, setLogViewerFollow(true))
    expect(on.logViewer.follow).toBe(true)
  })

  it("setLogViewerHorizontalOffset clamps negative to 0", () => {
    const state = processMonitorSlice.reducer(
      undefined,
      setLogViewerHorizontalOffset(-12)
    )
    expect(state.logViewer.horizontalOffset).toBe(0)
  })

  it("setLogViewerHorizontalOffset stores positive values", () => {
    const state = processMonitorSlice.reducer(
      undefined,
      setLogViewerHorizontalOffset(40)
    )
    expect(state.logViewer.horizontalOffset).toBe(40)
  })

  it("setSearchActive(true) opens the widget; setSearchActive(false) closes AND clears the query", () => {
    let state = processMonitorSlice.reducer(undefined, setSearchActive(true))
    state = processMonitorSlice.reducer(state, setSearchQuery("foo"))
    expect(state.logViewer.searchActive).toBe(true)
    expect(state.logViewer.searchQuery).toBe("foo")
    state = processMonitorSlice.reducer(state, setSearchActive(false))
    expect(state.logViewer.searchActive).toBe(false)
    expect(state.logViewer.searchQuery).toBe("")
  })

  it("setSearchQuery updates the term", () => {
    const state = processMonitorSlice.reducer(undefined, setSearchQuery("term"))
    expect(state.logViewer.searchQuery).toBe("term")
  })

  it("toggleLocationColumn flips locationVisible", () => {
    const off = processMonitorSlice.reducer(undefined, { type: "@@init" })
    expect(off.logViewer.locationVisible).toBe(false)
    const on = processMonitorSlice.reducer(off, toggleLocationColumn())
    expect(on.logViewer.locationVisible).toBe(true)
    const back = processMonitorSlice.reducer(on, toggleLocationColumn())
    expect(back.logViewer.locationVisible).toBe(false)
  })
})

describe("ProcessMonitorSelectors", () => {
  const state = {
    [SliceName.ProcessMonitor]: {
      processes: {
        a: mkLiveness("a", true),
        b: mkLiveness("b", false),
        c: mkLiveness("c", true)
      },
      logViewer: {
        path: "/tmp/x",
        offset: 5,
        follow: false,
        horizontalOffset: 0,
        searchActive: false,
        searchQuery: "",
        locationVisible: false
      }
    }
  } as any

  it("selectProcessMonitor returns the whole slice", () => {
    expect(selectProcessMonitor(state).processes.a.alive).toBe(true)
  })

  it("selectProcessMap returns just the label→liveness map", () => {
    expect(Object.keys(selectProcessMap(state))).toEqual(["a", "b", "c"])
  })

  it("selectAliveCount counts only `alive: true` entries", () => {
    expect(selectAliveCount(state)).toBe(2)
  })

  it("selectTotalCount counts every tracked liveness entry (drives the status badge denominator)", () => {
    expect(selectTotalCount(state)).toBe(3)
  })

  it("selectLogViewer returns the viewer sub-object", () => {
    expect(selectLogViewer(state)).toEqual({
      path: "/tmp/x",
      offset: 5,
      follow: false,
      horizontalOffset: 0,
      searchActive: false,
      searchQuery: "",
      locationVisible: false
    })
  })
})
