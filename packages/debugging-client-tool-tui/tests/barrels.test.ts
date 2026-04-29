/**
 * Barrel-export smoke tests. Every `index.ts` under src/ must forward its
 * neighbors' public symbols — these tests catch silent drift (e.g. a new slice
 * file that never got wired into the barrel). One assertion per barrel to keep
 * this fast.
 */
import * as servicesBarrel from "@wireio/debugging-client-tool-tui/services/index.js"
import * as storeBarrel from "@wireio/debugging-client-tool-tui/store/index.js"
import * as uiBarrel from "@wireio/debugging-client-tool-tui/store/ui/index.js"
import * as clusterBarrel from "@wireio/debugging-client-tool-tui/store/cluster/index.js"
import * as featuresBarrel from "@wireio/debugging-client-tool-tui/store/features/index.js"
import * as oppBarrel from "@wireio/debugging-client-tool-tui/store/opp/index.js"
import * as pmBarrel from "@wireio/debugging-client-tool-tui/store/process-monitor/index.js"

describe("services/index.ts", () => {
  it("re-exports ServiceManager, ReduxService, ServiceId, and the React context", () => {
    expect(servicesBarrel).toEqual(
      expect.objectContaining({
        ServiceManager: expect.any(Function),
        ReduxService: expect.any(Function),
        ServiceId: expect.any(Object),
        ServiceManagerProvider: expect.any(Function),
        useService: expect.any(Function),
        useServiceManager: expect.any(Function),
        useServices: expect.any(Function),
        asServiceType: expect.any(Function)
      })
    )
  })
})

describe("store/index.ts", () => {
  it("re-exports slice actions, selectors, and SliceName", () => {
    expect(storeBarrel).toEqual(
      expect.objectContaining({
        SliceName: expect.any(Object),
        store: expect.any(Object),
        useAppDispatch: expect.any(Function),
        useAppSelector: expect.any(Function),
        setStatus: expect.any(Function),
        setCluster: expect.any(Function),
        registerFeature: expect.any(Function),
        appendEnvelope: expect.any(Function)
      })
    )
  })
})

describe("store sub-barrels", () => {
  it("ui/ exposes uiSlice + setStatus + selectUI", () => {
    expect(uiBarrel).toEqual(
      expect.objectContaining({
        uiSlice: expect.any(Object),
        setStatus: expect.any(Function),
        selectUI: expect.any(Function)
      })
    )
  })

  it("cluster/ exposes clusterSlice + setCluster + selectCluster", () => {
    expect(clusterBarrel).toEqual(
      expect.objectContaining({
        clusterSlice: expect.any(Object),
        setCluster: expect.any(Function),
        selectCluster: expect.any(Function)
      })
    )
  })

  it("features/ exposes featuresSlice + registerFeature + setActiveFeatures + selectFeatures", () => {
    expect(featuresBarrel).toEqual(
      expect.objectContaining({
        featuresSlice: expect.any(Object),
        registerFeature: expect.any(Function),
        setActiveFeatures: expect.any(Function),
        selectFeatures: expect.any(Function)
      })
    )
  })

  it("opp/ exposes oppSlice + appendEnvelope + hydrate + clear + selectors", () => {
    expect(oppBarrel).toEqual(
      expect.objectContaining({
        oppSlice: expect.any(Object),
        appendEnvelope: expect.any(Function),
        hydrate: expect.any(Function),
        clear: expect.any(Function),
        selectOPP: expect.any(Function),
        selectCurrentEpochIndex: expect.any(Function),
        selectLatestEpoch: expect.any(Function),
        selectAllEpochsDescending: expect.any(Function),
        selectEpochByNumber: expect.any(Function)
      })
    )
  })

  it("process-monitor/ exposes processMonitorSlice + all actions + all selectors", () => {
    expect(pmBarrel).toEqual(
      expect.objectContaining({
        processMonitorSlice: expect.any(Object),
        setProcess: expect.any(Function),
        removeProcess: expect.any(Function),
        setLogViewerPath: expect.any(Function),
        setLogViewerOffset: expect.any(Function),
        setLogViewerFollow: expect.any(Function),
        toggleLocationColumn: expect.any(Function),
        selectProcessMonitor: expect.any(Function),
        selectProcessMap: expect.any(Function),
        selectAliveCount: expect.any(Function),
        selectTotalCount: expect.any(Function),
        selectLogViewer: expect.any(Function)
      })
    )
  })
})
