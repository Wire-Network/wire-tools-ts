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
  })
})

describe("ClusterStateNode / ClusterState shape", () => {
  const GenesisHash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"
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
    solanaIdlFile: null,
    solanaGenesisHash: GenesisHash
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

  it("loads a legacy snapshot without solanaGenesisHash as unprovisioned", () => {
    const legacy = JSON.parse(ClusterStateSchemaCodec.serialize(state))
    delete legacy.solanaGenesisHash
    expect(
      ClusterStateSchemaCodec.deserialize(JSON.stringify(legacy))
        .solanaGenesisHash
    ).toBeNull()
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
