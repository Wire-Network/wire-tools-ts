import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  ClusterKeyStore,
  type OperatorAccount
} from "@wireio/cluster-tool/orchestration/outputs"

function nodeKeys(index: number): ClusterKeyStore.NodeKeys {
  return {
    index,
    keys: {
      k1: { type: KeyType.K1, publicKey: `PUB_K1_node${index}`, privateKey: `PVT_K1_node${index}` },
      bls: {
        type: KeyType.BLS,
        publicKey: `PUB_BLS_node${index}`,
        privateKey: `PVT_BLS_node${index}`,
        proofOfPossession: `SIG_BLS_node${index}`
      }
    }
  }
}

function operatorAccount(account: string, type: OperatorType): OperatorAccount {
  return {
    label: account,
    account,
    type,
    wire: { type: KeyType.K1, publicKey: `PUB_K1_${account}`, privateKey: `PVT_K1_${account}` }
  }
}

describe("ClusterKeyStore", () => {
  it("accumulates node key sets and resolves them by index", () => {
    const store = new ClusterKeyStore().pushNodes(nodeKeys(0), nodeKeys(1))
    expect(store.nodes.length).toBe(2)
    expect(store.node(1).keys.k1.publicKey).toBe("PUB_K1_node1")
    expect(() => store.node(9)).toThrow(/no generated keys for producer node 9/)
  })

  it("accumulates operator accounts as they are provisioned (set/get/require)", () => {
    const store = new ClusterKeyStore()
    expect(() => store.assertOperator("batchopaaaa")).toThrow(/has not been provisioned/)
    store.setOperator(operatorAccount("batchopaaaa", OperatorType.BATCH))
    store.setOperator(operatorAccount("uwritaaaaaa", OperatorType.UNDERWRITER))
    expect(store.assertOperator("batchopaaaa").type).toBe(OperatorType.BATCH)
    expect(store.operator("uwritaaaaaa").account).toBe("uwritaaaaaa")
    expect(store.operators.length).toBe(2)
  })

  it("replaces an operator re-set under the same account (single source of truth)", () => {
    const store = new ClusterKeyStore()
      .setOperator(operatorAccount("depositoraaa", OperatorType.BATCH))
      .setOperator(operatorAccount("depositoraaa", OperatorType.UNDERWRITER))
    expect(store.operators.length).toBe(1)
    expect(store.assertOperator("depositoraaa").type).toBe(OperatorType.UNDERWRITER)
  })

  it("filters operators by type (producers vs OPP operators)", () => {
    const store = new ClusterKeyStore()
      .setOperator(operatorAccount("defproducera", OperatorType.PRODUCER))
      .setOperator(operatorAccount("defproducerb", OperatorType.PRODUCER))
      .setOperator(operatorAccount("batchopaaaa", OperatorType.BATCH))
    expect(store.operatorsByType(OperatorType.PRODUCER).map(op => op.account)).toEqual([
      "defproducera",
      "defproducerb"
    ])
    expect(store.operatorsByType(OperatorType.UNDERWRITER)).toEqual([])
  })
})

describe("ClusterKeyStore label keying", () => {
  it("keys operators by label — a generated chain account is reachable only via its label", () => {
    const store = new ClusterKeyStore().setOperator({
      label: "batchop.a",
      account: "wireno.x3f9k",
      type: OperatorType.BATCH,
      wire: { type: KeyType.K1, publicKey: "PUB_K1_a", privateKey: "PVT_K1_a" }
    })
    expect(store.assertOperator("batchop.a").account).toBe("wireno.x3f9k")
    expect(store.operator("wireno.x3f9k")).toBeUndefined()
  })

  it("setOperator with the same label REPLACES the entry (sponsored-creation account write-back)", () => {
    const store = new ClusterKeyStore()
      .setOperator(operatorAccount("batchop.a", OperatorType.BATCH))
      .setOperator({
        ...operatorAccount("batchop.a", OperatorType.BATCH),
        account: "wireno.q8m2c"
      })
    expect(store.operators.length).toBe(1)
    expect(store.assertOperator("batchop.a").account).toBe("wireno.q8m2c")
  })

  it("operatorsByType sorts by label regardless of insertion order", () => {
    const store = new ClusterKeyStore()
      .setOperator(operatorAccount("batchop.c", OperatorType.BATCH))
      .setOperator(operatorAccount("batchop.a", OperatorType.BATCH))
      .setOperator(operatorAccount("batchop.b", OperatorType.BATCH))
    expect(store.operatorsByType(OperatorType.BATCH).map(op => op.label)).toEqual([
      "batchop.a",
      "batchop.b",
      "batchop.c"
    ])
  })
})
