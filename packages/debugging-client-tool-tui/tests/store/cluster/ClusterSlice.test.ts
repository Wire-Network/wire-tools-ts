import {
  ClusterConfigLoggingFileFormat,
  ClusterConfigReportFormat,
  ClusterStateNodeRole,
  SignatureProviderType,
  type ClusterConfig,
  type ClusterState
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import {
  clusterSlice,
  setCluster,
  type ClusterSliceState
} from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSlice.js"
import { selectCluster } from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSelectors.js"
import {
  store,
  type RootState
} from "@wireio/debugging-client-tool-tui/store/Store.js"
import { SliceName } from "@wireio/debugging-client-tool-tui/store/StoreTypes.js"

/** A complete `ClusterConfig` fixture — no field left to `as unknown as`. */
const stubConfig: ClusterConfig = {
  buildPath: "/build",
  clusterPath: "/cluster",
  dataPath: "/cluster/data",
  walletPath: "/cluster/wallet",
  producerCount: 1,
  nodeCount: 1,
  batchOperatorCount: 0,
  underwriterCount: 0,
  epochDurationSec: 60,
  operatorsPerEpoch: null,
  batchOpGroups: null,
  epochRetentionEnvelopeLogCount: null,
  warmupEpochs: 0,
  cooldownEpochs: 0,
  terminateMaxConsecutiveMisses: null,
  terminateMaxPercentMisses24h: null,
  terminateWindowMs: null,
  ethereumPath: "/eth",
  solanaPath: "/sol",
  bind: {
    kiod: { address: "127.0.0.1", port: 8900 },
    nodeop: {
      address: "127.0.0.1",
      ports: {
        bios: { http: 8888, p2p: 9876 },
        producers: [],
        batch: [],
        underwriters: []
      }
    },
    anvil: { address: "127.0.0.1", port: 8545 },
    solana: {
      address: "127.0.0.1",
      ports: {
        http: 8899,
        faucet: 9900,
        gossip: 8001,
        dynamicRange: { first: 9010, last: 9019 }
      }
    },
    debuggingServer: { address: "127.0.0.1", port: 9901 }
  },
  executables: {
    nodeop: "/build/bin/nodeop",
    kiod: "/build/bin/kiod",
    clio: "/build/bin/clio",
    anvil: "/usr/bin/anvil",
    solanaTestValidator: "/usr/bin/solana-test-validator"
  },
  report: {
    path: "/cluster/reports",
    basename: "cluster-build",
    formats: [
      ClusterConfigReportFormat.csv,
      ClusterConfigReportFormat.md,
      ClusterConfigReportFormat.html
    ]
  },
  logging: {
    levels: { console: Level.info, file: Level.debug },
    fileFormat: ClusterConfigLoggingFileFormat.jsonl
  },
  requiredBatchOperatorCollateral: [],
  requiredUnderwriterCollateral: [],
  requiredProducerCollateral: [],
  underwriterCollateral: null,
  initialFinalizerKey: null,
  signatureProvider: { type: SignatureProviderType.KEY, ssm: null },
  externalOutposts: null,
  debuggingServerEnabled: true,
  enableMockReserves: false
}

/** A complete `ClusterState` fixture (post-bootstrap snapshot, no nodes). */
const stubState: ClusterState = {
  createdAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    {
      name: "bios",
      role: ClusterStateNodeRole.bios,
      nodePath: "/cluster/data/node_bios",
      ports: { http: 8888, p2p: 9876 },
      producers: ["sysio"],
      batchOperatorAccount: null,
      underwriterAccount: null
    }
  ],
  walletPath: "/cluster/wallet",
  anvilStateFile: "/cluster/data/anvil/anvil.json",
  solanaLedgerPath: "/cluster/data/solana_validator",
  solanaIdlFile: null
}

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
    // A genuine RootState (from the real store) with only the cluster slice
    // overridden — no cast needed to satisfy `selectCluster`'s signature.
    const state: RootState = { ...store.getState(), [SliceName.Cluster]: value }
    expect(selectCluster(state)).toEqual(value)
  })
})
