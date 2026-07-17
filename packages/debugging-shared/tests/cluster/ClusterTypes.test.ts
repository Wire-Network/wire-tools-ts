import {
  ClusterFiles,
  ClusterStateNodeRole,
  ClusterStateVersion,
  type ClusterState,
  type ClusterStateNode,
  type PersistedClusterConfig
} from "@wireio/debugging-shared"

describe("ClusterFiles", () => {
  it("carries the three canonical on-disk filenames", () => {
    expect(ClusterFiles.ConfigFilename).toBe("cluster-config.json")
    expect(ClusterFiles.StateFilename).toBe("cluster-state.json")
    expect(ClusterFiles.KeysFilename).toBe("cluster-keys.json")
  })
})

describe("ClusterStateVersion", () => {
  it("is the v2 schema stamp", () => {
    expect(ClusterStateVersion).toBe(2)
  })
})

describe("ClusterStateNodeRole", () => {
  it("is an identity-mapped string enum (value === key) for every member", () => {
    expect(ClusterStateNodeRole.bios).toBe("bios")
    expect(ClusterStateNodeRole.producer).toBe("producer")
    expect(ClusterStateNodeRole.operator).toBe("operator")
  })
})

describe("ClusterStateNode / ClusterState shape", () => {
  const biosNode: ClusterStateNode = {
    name: "bios",
    role: ClusterStateNodeRole.bios,
    nodePath: "/cluster/data/bios",
    ports: { http: 8888, p2p: 9876 },
    producers: ["defproducera"],
    batchOperatorAccount: null,
    underwriterAccount: null
  }

  const operatorNode: ClusterStateNode = {
    name: "node_01",
    role: ClusterStateNodeRole.operator,
    nodePath: "/cluster/data/node_01",
    ports: { http: 8889, p2p: 9877 },
    producers: [],
    batchOperatorAccount: "batchop1",
    underwriterAccount: null
  }

  const state: ClusterState = {
    version: ClusterStateVersion,
    createdAt: "2026-07-17T00:00:00.000Z",
    nodes: [biosNode, operatorNode],
    walletPath: "/cluster/wallet",
    anvilStateFile: "/cluster/data/anvil/anvil.json",
    solanaLedgerPath: "/cluster/data/solana_validator",
    solanaIdlFile: null
  }

  it("holds every node in ONE flat array, regardless of role", () => {
    expect(state.nodes).toHaveLength(2)
    expect(state.nodes.map(n => n.role)).toEqual([
      ClusterStateNodeRole.bios,
      ClusterStateNodeRole.operator
    ])
  })

  it("distinguishes a batch operator from an underwriter via batchOperatorAccount", () => {
    expect(operatorNode.batchOperatorAccount).toBe("batchop1")
    expect(operatorNode.underwriterAccount).toBeNull()
  })

  it("survives a JSON round-trip with no data loss (secret-free persistence)", () => {
    const rehydrated = JSON.parse(JSON.stringify(state)) as ClusterState
    expect(rehydrated).toEqual(state)
  })

  it("allows solanaIdlFile to be a concrete path when a SOL outpost is configured", () => {
    const withSolana: ClusterState = { ...state, solanaIdlFile: "/cluster/data/idl.json" }
    expect(withSolana.solanaIdlFile).toBe("/cluster/data/idl.json")
  })
})

describe("PersistedClusterConfig shape", () => {
  const config: PersistedClusterConfig = {
    buildPath: "/build",
    clusterPath: "/cluster",
    dataPath: "/cluster/data",
    walletPath: "/cluster/wallet",
    producerCount: 21,
    nodeCount: 1,
    batchOperatorCount: 3,
    underwriterCount: 1,
    epochDurationSec: 60,
    warmupEpochs: 1,
    cooldownEpochs: 1,
    ethereumPath: "/eth",
    solanaPath: "/sol",
    bind: {
      kiod: { address: "127.0.0.1", port: 8900 },
      nodeop: {
        address: "127.0.0.1",
        ports: {
          bios: { http: 8888, p2p: 9876 },
          producers: [{ http: 8988, p2p: 9976 }],
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
          dynamicRange: { first: 8100, last: 8200 }
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
      formats: ["csv", "md", "html"]
    },
    logging: {
      levels: { console: "info", file: "debug" },
      fileFormat: "jsonl"
    },
    requiredBatchOperatorCollateral: [
      { chainCode: 1, tokenCode: 2, minimumBond: 1000 }
    ],
    requiredUnderwriterCollateral: [],
    requiredProducerCollateral: [],
    underwriterCollateral: null,
    initialFinalizerKey: null
  }

  it("accepts the report/logging literal-union fields with no cast", () => {
    expect(config.report.formats).toEqual(["csv", "md", "html"])
    expect(config.logging.fileFormat).toBe("jsonl")
    expect(config.logging.levels.console).toBe("info")
  })

  it("survives a JSON round-trip with no data loss", () => {
    const rehydrated = JSON.parse(JSON.stringify(config)) as PersistedClusterConfig
    expect(rehydrated).toEqual(config)
  })

  it("carries per-role collateral requirements as plain (chain, token, bond) triples", () => {
    expect(config.requiredBatchOperatorCollateral).toEqual([
      { chainCode: 1, tokenCode: 2, minimumBond: 1000 }
    ])
  })
})
