import {
  ClusterDeploymentKind,
  type BindConfigNodeopPorts,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { asOption } from "@3fv/prelude-ts"
import { range } from "lodash"
import { match, P } from "ts-pattern"
import { Constants } from "../Constants.js"
import type { Renderer } from "../utils/Renderer.js"
import { toDialAddress } from "../utils/netUtils.js"

import { NodeConfigIniRenderer } from "./renderers/NodeConfigIniRenderer.js"
import { NodeConfigLoggingRenderer } from "./renderers/NodeConfigLoggingRenderer.js"

/**
 * A planned node's role — explicit operator kinds per the author's directive.
 * Identity-mapped string enum so `match` patterns and JSON round-trips are
 * clean.
 */
export enum NodeRole {
  bios = "bios",
  producer = "producer",
  batch_operator = "batch_operator",
  underwriter = "underwriter"
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
  return quotient > 0
    ? alphaStrBase(quotient, base) + base[remainder]
    : base[remainder]
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
  batchOperatorLabel: string | null
  underwriterLabel: string | null
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
    readonly batchOperatorLabel: string | null = null,
    readonly underwriterLabel: string | null = null
  ) {
    this.ini = new NodeConfigIniRenderer(this)
    this.logging = new NodeConfigLoggingRenderer(this)
  }

  /** Absolute on-disk directory for this node's data + logs. */
  get nodePath(): string {
    return `${this.cluster.dataPath}/${this.name}`
  }

  /**
   * The address THIS node advertises (its `p2p-server-address`, and what peers
   * dial): the per-node `ports.advertiseAddress` when bound (multi-host mesh),
   * else the fleet-wide bind address mapped through `toDialAddress`.
   */
  get advertiseAddress(): string {
    return NodeConfig.advertiseAddressFor(this.cluster, this.ports)
  }

  /**
   * Plan every node in the cluster from its resolved binding: a bios node, one
   * producer node per `bind.nodeop.ports.producers[]` (with the defproducer
   * names round-robin-distributed), and one operator node per batch-op /
   * underwriter port pair (associated by its durable `label` handle — the
   * `account` is generated at provisioning time and resolved from the key
   * store). Peer endpoints are every other node's advertised p2p endpoint —
   * each node's own `ports.advertiseAddress` when bound (multi-host mesh),
   * else the shared dialable bind address.
   *
   * @param cluster - The resolved cluster config.
   * @returns The planned nodes, bios first.
   */
  static plan(cluster: ClusterConfig): NodeConfig[] {
    const nodeopPorts = cluster.bind.nodeop.ports,
      producerNodeCount = nodeopPorts.producers.length,
      producerNames = range(cluster.producerCount).map(i => producerName(i)),
      descriptors: NodeDescriptor[] = [
        {
          role: NodeRole.bios,
          index: NodeConfig.BiosIndex,
          name: NodeConfig.BiosName,
          ports: nodeopPorts.bios,
          producers: [NodeConfig.BiosProducer],
          batchOperatorLabel: null,
          underwriterLabel: null
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
        batchOperatorLabel: null,
        underwriterLabel: null
      })
    )

    let opIndex = producerNodeCount
    nodeopPorts.batch.forEach((ports, k) =>
      descriptors.push({
        role: NodeRole.batch_operator,
        index: opIndex++,
        name: nodeName(opIndex - 1),
        ports,
        producers: [],
        batchOperatorLabel: Constants.batchOperatorLabel(k),
        underwriterLabel: null
      })
    )
    nodeopPorts.underwriters.forEach((ports, k) =>
      descriptors.push({
        role: NodeRole.underwriter,
        index: opIndex++,
        name: nodeName(opIndex - 1),
        ports,
        producers: [],
        batchOperatorLabel: null,
        underwriterLabel: Constants.underwriterLabel(k)
      })
    )

    // The MESH is the block-producing set only (bios + producers). Operator
    // nodes attach to it at a single point instead of joining it — see
    // `peersFor`.
    const meshDescriptors = descriptors.filter(
        node => !NodeConfig.isOperatorRole(node.role)
      ),
      // Operators' single attachment point. Falls back to the bios node when a
      // cluster has no producer nodes at all, so an operator is never peerless.
      operatorUplink = asOption(
        descriptors.find(node => node.role === NodeRole.producer)
      ).getOrElse(meshDescriptors[0])

    return descriptors.map(
      d =>
        new NodeConfig(
          cluster,
          d.role,
          d.index,
          d.name,
          d.ports,
          d.producers,
          peersFor(d, meshDescriptors, operatorUplink).map(
            other =>
              `${NodeConfig.advertiseAddressFor(cluster, other.ports)}:${other.ports.p2p}`
          ),
          d.batchOperatorLabel,
          d.underwriterLabel
        )
    )
  }
}

/**
 * The p2p peers ONE node dials — a mesh of PRODUCERS with operators hanging
 * off it, never one flat mesh of everything.
 *
 * - **bios / producer** → every other mesh member (the block-producing set).
 * - **batch operator / underwriter** → exactly ONE producer (`operatorUplink`).
 *
 * Operators are excluded from the mesh because p2p flooding is O(N²) in mesh
 * size, and operator nodes produce nothing — they only need a view of the chain
 * and a path to submit. Meshing them bought nothing and cost quadratically: at a
 * 21-producer/22-operator topology a full mesh is 43 peers per node and 946
 * connections, which drove block-relay latency to 28–45s ON LOOPBACK with the
 * host 83% idle. Blocks then arrived outside the finalizer voting window, so
 * finalizers could only vote WEAK, no quorum certificate formed, and LIB froze
 * while head kept advancing — reproduced on four consecutive 21-producer
 * bootstraps (2026-08-04). Restricting the mesh to producers takes it to 22
 * members and leaves each operator with one link.
 *
 * @param node - The node whose peers are being resolved.
 * @param meshDescriptors - Every mesh member (bios + producers).
 * @param operatorUplink - The producer an operator attaches to.
 * @returns The descriptors this node dials.
 */
function peersFor(
  node: NodeDescriptor,
  meshDescriptors: NodeDescriptor[],
  operatorUplink: NodeDescriptor
): NodeDescriptor[] {
  return match(node.role)
    .with(P.when(NodeConfig.isOperatorRole), () =>
      operatorUplink != null ? [operatorUplink] : []
    )
    .otherwise(() => meshDescriptors.filter(other => other.name !== node.name))
}

export namespace NodeConfig {
  /** The operator-kind roles (batch + underwriter) — the ONE derived "any
   *  operator" set. */
  export const OperatorRoles: ReadonlyArray<NodeRole> = [
    NodeRole.batch_operator,
    NodeRole.underwriter
  ]

  /**
   * Whether `role` is an operator kind — the single predicate every "is this an
   * operator node?" site reads, so the set lives in exactly one place.
   *
   * @param role - The planned node's role.
   * @returns `true` for a batch-operator or underwriter node.
   */
  export function isOperatorRole(role: NodeConfig["role"]): boolean {
    return NodeConfig.OperatorRoles.includes(role)
  }

  /**
   * Whether this node's rendered nodeop config loads
   * `sysio::trace_api_plugin` — the ONE predicate the ini renderer, the argv
   * builder, and the `--trace-no-abis` probe all read, so the three surfaces
   * cannot disagree about whether the plugin is loaded.
   *
   * SHARED-25 AC#4 with the author's explicit D3 carve-out: LOCAL clusters keep
   * it on EVERY role (the harness's `WireClient` reads traces off `producer[0]`,
   * so dropping it there breaks every flow); the production-shaped
   * `create-external-config` tree drops it from bios / producer-role nodes;
   * operator nodes are non-public and retain it everywhere.
   *
   * @param node - The planned node (its `cluster` carries the deployment kind).
   * @returns `true` when the node loads the trace-api plugin.
   */
  export function runsTraceApiPlugin(node: NodeConfig): boolean {
    return (
      NodeConfig.isOperatorRole(node.role) ||
      node.cluster.deploymentKind !== ClusterDeploymentKind.external
    )
  }

  /** Bios node index (matches the Python launcher). */
  export const BiosIndex = -100
  /** Bios node name. */
  export const BiosName = "node_bios"
  /** The producer the bios node runs. */
  export const BiosProducer = "sysio"

  /** The bios node's contribution to the loopback peer allowance. */
  export const BiosNodeCount = 1

  /** Extra loopback inbound slots for flow-provisioned ad-hoc daemons. */
  export const AdHocDaemonPeerHeadroom = 3

  /**
   * How many cluster peers ONE node must tolerate: the whole planned topology
   * (bios + producer nodes + batch operators + underwriters) plus headroom for
   * flow-provisioned ad-hoc daemons.
   *
   * Every node is wired to every other (a full mesh on loopback), so this is
   * the bound for BOTH `--p2p-max-nodes-per-host` and `--max-clients`. Capping
   * either BELOW the mesh size is silently fatal at scale: `max-clients` limits
   * INBOUND p2p connections, so a fixed cap smaller than the peer count makes
   * each node refuse the surplus dials. The mesh never fully forms, blocks
   * route the long way, propagation latency explodes, and finalizers fall
   * outside their voting window — they can then only vote WEAK, no quorum
   * certificate forms, and LIB freezes while head keeps advancing. Every
   * `pushActionAndWait` at irreversible finality then hangs forever.
   *
   * (2026-08-04: a 21-producer/21-batch-op create wired 43 peers per node
   * against a fixed `max-clients = 25`; LIB froze at 546 with head past 600
   * and the bootstrap died in `BringUpAccounts`. Small clusters hid it — at 1
   * producer the mesh is ~2 connections.)
   *
   * @param cluster - The resolved cluster config (carries the topology counts).
   * @returns The per-node peer capacity.
   */
  export function peerCapacity(cluster: ClusterConfig): number {
    return (
      cluster.nodeCount +
      cluster.batchOperatorCount +
      cluster.underwriterCount +
      BiosNodeCount +
      AdHocDaemonPeerHeadroom
    )
  }

  /**
   * The advertised (dialable) address for one node's binding: its per-node
   * `advertiseAddress` when bound (multi-host mesh), else the fleet-wide
   * `cluster.bind.nodeop.address` mapped through `toDialAddress`.
   *
   * @param cluster - The resolved cluster config (fleet-wide bind address).
   * @param ports - The node's binding (may pin a per-node advertise address).
   * @returns The address peers dial / the node advertises.
   */
  export function advertiseAddressFor(
    cluster: ClusterConfig,
    ports: BindConfigNodeopPorts
  ): string {
    return ports.advertiseAddress ?? toDialAddress(cluster.bind.nodeop.address)
  }
}
