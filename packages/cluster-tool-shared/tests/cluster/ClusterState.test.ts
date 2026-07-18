import {
  ClusterStateNodeRole,
  type ClusterState,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"

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
    const withSolana: ClusterState = {
      ...state,
      solanaIdlFile: "/cluster/data/idl.json"
    }
    expect(withSolana.solanaIdlFile).toBe("/cluster/data/idl.json")
  })
})
