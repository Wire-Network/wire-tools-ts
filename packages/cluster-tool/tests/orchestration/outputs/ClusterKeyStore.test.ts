import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { ClusterKeyStore } from "@wireio/cluster-tool/orchestration/outputs"
import { fixtureOperatorAccount } from "./operatorAccountFixture.js"

function nodeKeys(index: number): ClusterKeyStore.NodeKeys {
  return {
    index,
    keys: {
      wire: { type: KeyType.K1, publicKey: `PUB_K1_node${index}`, privateKey: `PVT_K1_node${index}` },
      wireFinalizer: {
        type: KeyType.BLS,
        publicKey: `PUB_BLS_node${index}`,
        privateKey: `PVT_BLS_node${index}`,
        proofOfPossession: `SIG_BLS_node${index}`
      }
    }
  }
}

describe("ClusterKeyStore", () => {
  it("accumulates node key sets and resolves them by index", () => {
    const store = new ClusterKeyStore().pushNodes(nodeKeys(0), nodeKeys(1))
    expect(store.nodes.length).toBe(2)
    expect(store.node(1).keys.wire.publicKey).toBe("PUB_K1_node1")
    expect(() => store.node(9)).toThrow(/no generated keys for producer node 9/)
  })

  it("accumulates operator accounts as they are provisioned (set/get/require)", () => {
    const store = new ClusterKeyStore()
    expect(() => store.assertOperator("batchopaaaa")).toThrow(/has not been provisioned/)
    store.setOperator(fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH))
    store.setOperator(fixtureOperatorAccount("uwritaaaaaa", OperatorType.UNDERWRITER))
    expect(store.assertOperator("batchopaaaa").type).toBe(OperatorType.BATCH)
    expect(store.operator("uwritaaaaaa").label).toBe("uwritaaaaaa")
    expect(store.operators.length).toBe(2)
  })

  it("replaces an operator re-set under the same label (single source of truth)", () => {
    const store = new ClusterKeyStore()
      .setOperator(fixtureOperatorAccount("depositoraaa", OperatorType.BATCH))
      .setOperator(fixtureOperatorAccount("depositoraaa", OperatorType.UNDERWRITER))
    expect(store.operators.length).toBe(1)
    expect(store.assertOperator("depositoraaa").type).toBe(OperatorType.UNDERWRITER)
  })

  it("filters operators by type (producers vs OPP operators)", () => {
    const store = new ClusterKeyStore()
      .setOperator(fixtureOperatorAccount("defproducera", OperatorType.PRODUCER))
      .setOperator(fixtureOperatorAccount("defproducerb", OperatorType.PRODUCER))
      .setOperator(fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH))
    expect(store.operatorsByType(OperatorType.PRODUCER).map(op => op.label)).toEqual([
      "defproducera",
      "defproducerb"
    ])
    expect(store.operatorsByType(OperatorType.UNDERWRITER)).toEqual([])
  })
})

describe("ClusterKeyStore account-handle keying", () => {
  it("keys operators by the DURABLE handle — the generated account is not a key", () => {
    const store = new ClusterKeyStore().setOperator({
      label: "batchop.a",
      publicationLabel: "batchop.a",
      account: "wireno.x3f9k",
      type: OperatorType.BATCH,
      wire: { type: KeyType.K1, publicKey: "PUB_K1_a", privateKey: "PVT_K1_a" }
    })
    expect(store.assertOperator("batchop.a").account).toBe("wireno.x3f9k")
    expect(store.operator("wireno.x3f9k")).toBeUndefined()
  })

  it("setOperator must not default account := label (materialized, pre-sponsored-creation)", () => {
    const store = new ClusterKeyStore().setOperator({
      label: "batchop.a",
      publicationLabel: "batchop.a",
      type: OperatorType.BATCH,
      wire: { type: KeyType.K1, publicKey: "PUB_K1_a", privateKey: "PVT_K1_a" }
    })
    expect(store.assertOperator("batchop.a").label).toBe("batchop.a")
    expect(store.assertOperator("batchop.a").account).toBeUndefined()
  })

  it("setOperator with the same handle REPLACES the entry (sponsored-creation account write-back)", () => {
    const store = new ClusterKeyStore()
      .setOperator(fixtureOperatorAccount("batchop.a", OperatorType.BATCH))
      .setOperator({
        ...fixtureOperatorAccount("batchop.a", OperatorType.BATCH),
        account: "wireno.q8m2c"
      })
    expect(store.operators.length).toBe(1)
    // The write-back changes ONLY the chain account — the handle is the key.
    expect(store.assertOperator("batchop.a").account).toBe("wireno.q8m2c")
    expect(store.assertOperator("batchop.a").label).toBe("batchop.a")
  })

  it("operatorsByType sorts by the durable handle regardless of insertion order", () => {
    const store = new ClusterKeyStore()
      .setOperator(fixtureOperatorAccount("batchop.c", OperatorType.BATCH))
      .setOperator(fixtureOperatorAccount("batchop.a", OperatorType.BATCH))
      .setOperator(fixtureOperatorAccount("batchop.b", OperatorType.BATCH))
    expect(store.operatorsByType(OperatorType.BATCH).map(op => op.label)).toEqual([
      "batchop.a",
      "batchop.b",
      "batchop.c"
    ])
  })
})
