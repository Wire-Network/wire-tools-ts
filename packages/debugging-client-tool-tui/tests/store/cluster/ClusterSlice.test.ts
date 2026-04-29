import type { ClusterConfig, ClusterState } from "@wireio/debugging-shared"
import {
  clusterSlice,
  setCluster,
  type ClusterSliceState
} from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSlice.js"
import { selectCluster } from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSelectors.js"
import { SliceName } from "@wireio/debugging-client-tool-tui/store/StoreTypes.js"

const stubConfig = {
  ports: { debuggingServer: 9901 }
} as unknown as ClusterConfig
const stubState = {
  nodes: [],
  batchOperatorNodes: [],
  underwriterNodes: []
} as unknown as ClusterState

describe("clusterSlice", () => {
  it("initial state has all three fields null", () => {
    const state = clusterSlice.reducer(undefined, { type: "@@init" })
    expect(state).toEqual({ path: null, config: null, state: null })
  })

  it("setCluster replaces path + config + state in one action", () => {
    const updated = clusterSlice.reducer(
      undefined,
      setCluster({ path: "/tmp/c", config: stubConfig, state: stubState })
    )
    expect(updated).toEqual({
      path: "/tmp/c",
      config: stubConfig,
      state: stubState
    })
  })

  it("setCluster accepts null state for pre-bootstrap clusters", () => {
    const updated = clusterSlice.reducer(
      undefined,
      setCluster({ path: "/tmp/c", config: stubConfig, state: null })
    )
    expect(updated.state).toBeNull()
  })
})

describe("selectCluster", () => {
  it("returns the cluster sub-state keyed by SliceName.Cluster", () => {
    const value: ClusterSliceState = {
      path: "/x",
      config: stubConfig,
      state: null
    }
    expect(selectCluster({ [SliceName.Cluster]: value } as any)).toEqual(value)
  })
})
