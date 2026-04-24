import {
  processMonitorSlice,
  removeProcess,
  setLogViewerFollow,
  setLogViewerOffset,
  setLogViewerPath,
  setProcess
} from "@wire-e2e-tests/debugging-client-tool-tui/store/processMonitor/ProcessMonitorSlice.js"
import type { ProcessLiveness } from "@wire-e2e-tests/debugging-client-tool-tui/store/processMonitor/ProcessMonitorTypes.js"
import {
  selectAliveCount,
  selectLogViewer,
  selectProcessMap,
  selectProcessMonitor
} from "@wire-e2e-tests/debugging-client-tool-tui/store/processMonitor/ProcessMonitorSelectors.js"
import { SliceName } from "@wire-e2e-tests/debugging-client-tool-tui/store/StoreTypes.js"

function mkLiveness(label: string, alive: boolean, pid: number | null = 1): ProcessLiveness {
  return { label, pid, alive, lastCheckedAt: 0, exitedAt: alive ? null : 0 }
}

describe("processMonitorSlice", () => {
  it("initial state: empty map + default viewer", () => {
    const state = processMonitorSlice.reducer(undefined, { type: "@@init" })
    expect(state.processes).toEqual({})
    expect(state.logViewer).toEqual({ path: null, offset: 0, follow: true })
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

  it("setLogViewerPath resets offset + re-enables follow", () => {
    const priming = processMonitorSlice.reducer(
      undefined,
      setLogViewerOffset(100)
    )
    expect(priming.logViewer.follow).toBe(false)
    expect(priming.logViewer.offset).toBe(100)
    const switched = processMonitorSlice.reducer(
      priming,
      setLogViewerPath("/tmp/log")
    )
    expect(switched.logViewer).toEqual({ path: "/tmp/log", offset: 0, follow: true })
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
})

describe("ProcessMonitorSelectors", () => {
  const state = {
    [SliceName.ProcessMonitor]: {
      processes: {
        a: mkLiveness("a", true),
        b: mkLiveness("b", false),
        c: mkLiveness("c", true)
      },
      logViewer: { path: "/tmp/x", offset: 5, follow: false }
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

  it("selectLogViewer returns the viewer sub-object", () => {
    expect(selectLogViewer(state)).toEqual({
      path: "/tmp/x",
      offset: 5,
      follow: false
    })
  })
})
