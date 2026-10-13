import {
  ClusterStateNodeRole,
  ClusterStateSchemaCodec,
  type ClusterState,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"

describe("ClusterStateNodeRole", () => {
  it("is an identity-mapped string enum (value === key) for every member", () => {
    expect(ClusterStateNodeRole.bios).toBe("bios")
    expect(ClusterStateNodeRole.producer).toBe("producer")
    expect(ClusterStateNodeRole.operator).toBe("operator")
    expect(ClusterStateNodeRole.api).toBe("api")
  })
})

describe("ClusterStateNode / ClusterState shape", () => {
  const biosNode: ClusterStateNode = {
    name: "bios",
    role: ClusterStateNodeRole.bios,
    nodePath: "/cluster/data/bios",
    ports: { http: 8888, p2p: 9876 },
    producers: ["defproducera"],
    batchOperatorLabel: null,
    underwriterLabel: null
  }

  const operatorNode: ClusterStateNode = {
    name: "node_01",
    role: ClusterStateNodeRole.operator,
    nodePath: "/cluster/data/node_01",
    ports: { http: 8889, p2p: 9877 },
    producers: [],
    batchOperatorLabel: "batchop1",
    underwriterLabel: null
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

  it("distinguishes a batch operator from an underwriter via batchOperatorLabel", () => {
    expect(operatorNode.batchOperatorLabel).toBe("batchop1")
    expect(operatorNode.underwriterLabel).toBeNull()
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

  it("round-trips through ClusterStateSchemaCodec", () => {
    expect(
      ClusterStateSchemaCodec.deserialize(ClusterStateSchemaCodec.serialize(state))
    ).toEqual(state)
  })

  it("round-trips an api node row through ClusterStateSchemaCodec", () => {
    // Reuses the operator row's ports: the schema validates shape, not
    // port uniqueness.
    const apiNode: ClusterStateNode = {
        ...operatorNode,
        name: "node_02",
        role: ClusterStateNodeRole.api,
        nodePath: "/cluster/data/node_02",
        batchOperatorLabel: null
      },
      withApiNode: ClusterState = { ...state, nodes: [...state.nodes, apiNode] }
    expect(
      ClusterStateSchemaCodec.deserialize(
        ClusterStateSchemaCodec.serialize(withApiNode)
      )
    ).toEqual(withApiNode)
  })

  it("rejects a node role outside ClusterStateNodeRole", () => {
    expect(() =>
      ClusterStateSchemaCodec.deserialize(
        JSON.stringify({ ...state, nodes: [{ ...biosNode, role: "archive" }] })
      )
    ).toThrow(/nodes\.0\.role/)
  })

  it("allows null anvilStateFile/solanaLedgerPath (external-outpost mode)", () => {
    const external: ClusterState = {
      ...state,
      anvilStateFile: null,
      solanaLedgerPath: null
    }
    const rehydrated = ClusterStateSchemaCodec.deserialize(
      ClusterStateSchemaCodec.serialize(external)
    )
    expect(rehydrated.anvilStateFile).toBeNull()
    expect(rehydrated.solanaLedgerPath).toBeNull()
  })

})
