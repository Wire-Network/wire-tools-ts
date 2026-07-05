import { range } from "lodash"
import { Constants } from "../Constants.js"
import type { Renderer } from "../utils/Renderer.js"
import type { BindConfigNodeopPorts } from "./BindConfig.js"
import type { ClusterConfig } from "./ClusterConfig.js"
import { NodeConfigIniRenderer } from "./renderers/NodeConfigIniRenderer.js"
import { NodeConfigLoggingRenderer } from "./renderers/NodeConfigLoggingRenderer.js"

/**
 * The role a `nodeop` instance plays. Identity-mapped string enum so `match`
 * patterns and JSON round-trips are clean.
 */
export enum NodeRole {
  bios = "bios",
  producer = "producer",
  operator = "operator"
}

/** Index width used when padding a node index into its `node_NN` name. */
const NodeNamePadWidth = 2
const AsciiLower = "abcdefghijklmnopqrstuvwxyz"

/** Format a node index as its canonical `node_NN` name. */
function nodeName(index: number): string {
  return `node_${String(index).padStart(NodeNamePadWidth, "0")}`
}

/** Base-26 alpha string for a producer-name suffix. */
function alphaStrBase(num: number, base: string): string {
  const quotient = Math.floor(num / base.length),
    remainder = num % base.length
  return quotient > 0 ? alphaStrBase(quotient, base) + base[remainder] : base[remainder]
}

/**
 * Generate a producer account name from its index — `defproducera` … the first
 * 26, then `defpraaaaaab` … beyond.
 *
 * @param index - Zero-based producer index.
 * @param shared - Use the `shr` prefix instead of `def`.
 * @returns The producer account name.
 */
export function producerName(index: number, shared = false): string {
  const prefix = shared ? "shr" : "def"
  if (index > AsciiLower.length - 1) {
    const suffix = alphaStrBase(
      index - AsciiLower.length + 1,
      AsciiLower
    ).padStart(7, "a")
    return `${prefix}pr${suffix}`
  }
  return `${prefix}producer${AsciiLower[index]}`
}

/** Internal descriptor used while planning, before peer endpoints are known. */
interface NodeDescriptor {
  role: NodeRole
  index: number
  name: string
  ports: BindConfigNodeopPorts
  producers: readonly string[]
  batchOperatorAccount: string | null
  underwriterAccount: string | null
}

/**
 * One nodeop instance's configuration. `ini` / `logging` are `Renderer`s
 * producing the `config.ini` / `logging.json` content. Built en masse by
 * {@link NodeConfig.plan}, which maps the cluster's resolved nodeop ports
 * (`bind.nodeop.ports`) onto bios + producer + operator nodes.
 */
export class NodeConfig {
  readonly ini: Renderer
  readonly logging: Renderer

  constructor(
    readonly cluster: ClusterConfig,
    readonly role: NodeRole,
    readonly index: number,
    readonly name: string,
    readonly ports: BindConfigNodeopPorts,
    readonly producers: readonly string[],
    readonly peerEndpoints: readonly string[],
    readonly batchOperatorAccount: string | null = null,
    readonly underwriterAccount: string | null = null
  ) {
    this.ini = new NodeConfigIniRenderer(this)
    this.logging = new NodeConfigLoggingRenderer(this)
  }

  /** Absolute on-disk directory for this node's data + logs. */
  get nodePath(): string {
    return `${this.cluster.dataPath}/${this.name}`
  }

  /**
   * Plan every node in the cluster from its resolved binding: a bios node, one
   * producer node per `bind.nodeop.ports.producers[]` (with the defproducer
   * names round-robin-distributed), and one operator node per batch-op /
   * underwriter port pair. Peer endpoints are every other node's advertised
   * p2p endpoint.
   *
   * @param cluster - The resolved cluster config.
   * @returns The planned nodes, bios first.
   */
  static plan(cluster: ClusterConfig): NodeConfig[] {
    const nodeopPorts = cluster.bind.nodeop.ports,
      advertise = NodeConfigIniRenderer.Loopback,
      producerNodeCount = nodeopPorts.producers.length,
      producerNames = range(cluster.producerCount).map(i => producerName(i)),
      descriptors: NodeDescriptor[] = [
        {
          role: NodeRole.bios,
          index: NodeConfig.BiosIndex,
          name: NodeConfig.BiosName,
          ports: nodeopPorts.bios,
          producers: [NodeConfig.BiosProducer],
          batchOperatorAccount: null,
          underwriterAccount: null
        }
      ]

    nodeopPorts.producers.forEach((ports, k) =>
      descriptors.push({
        role: NodeRole.producer,
        index: k,
        name: nodeName(k),
        ports,
        producers: producerNames.filter(
          (_, i) => producerNodeCount > 0 && i % producerNodeCount === k
        ),
        batchOperatorAccount: null,
        underwriterAccount: null
      })
    )

    let opIndex = producerNodeCount
    nodeopPorts.batch.forEach((ports, k) =>
      descriptors.push({
        role: NodeRole.operator,
        index: opIndex++,
        name: nodeName(opIndex - 1),
        ports,
        producers: [],
        batchOperatorAccount: Constants.batchOperatorAccountName(k),
        underwriterAccount: null
      })
    )
    nodeopPorts.underwriters.forEach((ports, k) =>
      descriptors.push({
        role: NodeRole.operator,
        index: opIndex++,
        name: nodeName(opIndex - 1),
        ports,
        producers: [],
        batchOperatorAccount: null,
        underwriterAccount: Constants.underwriterAccountName(k)
      })
    )

    return descriptors.map(
      d =>
        new NodeConfig(
          cluster,
          d.role,
          d.index,
          d.name,
          d.ports,
          d.producers,
          descriptors
            .filter(other => other.name !== d.name)
            .map(other => `${advertise}:${other.ports.p2p}`),
          d.batchOperatorAccount,
          d.underwriterAccount
        )
    )
  }
}

export namespace NodeConfig {
  /** Bios node index (matches the Python launcher). */
  export const BiosIndex = -100
  /** Bios node name. */
  export const BiosName = "node_bios"
  /** The producer the bios node runs. */
  export const BiosProducer = "sysio"
}
