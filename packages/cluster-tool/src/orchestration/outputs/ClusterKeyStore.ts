import Assert from "node:assert"
import { OperatorType } from "@wireio/opp-typescript-models"
import type { WireFinalizerKeyPair, WireKeyPair } from "../../types/KeyPair.js"
import { outputKey, type OutputKey } from "../OutputStore.js"
import { OperatorAccount } from "./OperatorAccount.js"

/**
 * THE single key store for the whole cluster — accessed via `ctx.keyStore`.
 * Holds the generated producer-NODE signing sets (one K1+BLS per node) AND every
 * provisioned {@link OperatorAccount} (producer / batch operator / underwriter /
 * flow-provisioned), **accumulated as accounts are provisioned**: bootstrap
 * key-gen pushes the node sets, and every provisioning Phase's materialize step
 * {@link setOperator}s its operator, keyed by the durable `label` handle (never
 * by the generated on-chain `account`). There is no other place keys live —
 * consensus steps, node start (signature providers), authex links, deposit
 * tools, and daemon config all resolve from here.
 */
export class ClusterKeyStore {
  private readonly nodeList: ClusterKeyStore.NodeKeys[] = []
  private readonly operatorMap = new Map<string, OperatorAccount>()

  /** The generated producer-node signing sets, in node-index order. */
  get nodes(): ReadonlyArray<ClusterKeyStore.NodeKeys> {
    return this.nodeList
  }

  /** Every provisioned operator account, in provisioning order. */
  get operators(): ReadonlyArray<OperatorAccount> {
    return [...this.operatorMap.values()]
  }

  /** Append generated producer-node key sets (chainable). */
  pushNodes(...nodes: ClusterKeyStore.NodeKeys[]): this {
    this.nodeList.push(...nodes)
    return this
  }

  /**
   * A producer node's key set by topology index (throws when key generation
   * hasn't produced it).
   *
   * @param index - The producer node's topology index.
   * @returns The node's K1+BLS key set.
   */
  node(index: number): ClusterKeyStore.NodeKeys {
    const nodeKeys = this.nodeList.find(candidate => candidate.index === index)
    Assert.ok(nodeKeys != null, `ClusterKeyStore: no generated keys for producer node ${index}`)
    return nodeKeys
  }

  /** Add or replace a provisioned operator, keyed by its durable `label` handle (chainable). */
  setOperator(operator: OperatorAccount): this {
    this.operatorMap.set(operator.label, operator)
    return this
  }

  /** A provisioned operator by its durable `label` handle, or nothing when absent (see {@link assertOperator}). */
  operator(label: string): OperatorAccount {
    return this.operatorMap.get(label)
  }

  /**
   * A provisioned operator by its durable `label` handle — throws when the
   * operator hasn't been provisioned (its materialize step hasn't run).
   *
   * @param label - The operator's durable harness handle (NOT its on-chain `account`).
   * @returns The operator's label + on-chain account + keys.
   */
  assertOperator(label: string): OperatorAccount {
    const operator = this.operatorMap.get(label)
    Assert.ok(
      operator != null,
      `ClusterKeyStore: operator "${label}" has not been provisioned (no materialize step ran for it)`
    )
    return operator
  }

  /**
   * Every provisioned operator of `type`, sorted by `label`. Sorting (not
   * insertion order) keeps the listing deterministic — provisioning phases run
   * in parallel, so completion order varies run to run.
   */
  operatorsByType(type: OperatorType): OperatorAccount[] {
    return this.operators.filter(operator => operator.type === type).sort((a, b) => a.label.localeCompare(b.label))
  }
}

export namespace ClusterKeyStore {
  /** A producer node's WIRE block-signing (K1) + finality (BLS) keys. */
  export interface ProducerKeySet {
    /**
     * The node's WIRE block-signing key — the same concept as
     * {@link OperatorAccount.wire}, named identically on purpose: a node's
     * signing identity and an operator's are ONE shape, so one resolver and one
     * publication walker cover both. The former curve-named `k1`/`bls` is what
     * made the bios identity a special case (stored as an operator, published
     * as a node) and produced two SSM blockers.
     */
    readonly wire: WireKeyPair
    /** The node's WIRE finality key — same concept as {@link OperatorAccount.wireFinalizer}. */
    readonly wireFinalizer: WireFinalizerKeyPair
  }

  /** One producer node's key set + its topology index. */
  export interface NodeKeys {
    readonly index: number
    readonly keys: ProducerKeySet
  }
}

/** Typed cross-step handle to THE cluster {@link ClusterKeyStore} (prefer `ctx.keyStore`). */
export const ClusterKeyStoreKey: OutputKey<ClusterKeyStore> = outputKey(
  "cluster.keyStore",
  "the single cluster key store (producer-node K1/BLS sets + every provisioned OperatorAccount)"
)
