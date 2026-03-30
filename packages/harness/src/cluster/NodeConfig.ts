/**
 * Node configuration types and generation for Wire clusters.
 *
 * Mirrors port assignment and node role logic from:
 *   - wire-sysio/tests/TestHarness/launcher.py  (nodeDefinition, cluster_generator)
 *   - wire-sysio/tools/cluster_manager.py        (_create_cluster, nodeop_args)
 */

import {
  BASE_P2P_PORT,
  BASE_HTTP_PORT,
  BIOS_P2P_PORT,
  BIOS_HTTP_PORT,
  BASE_PLUGINS,
  PRODUCER_PLUGINS,
  NODEOP_EXTRA_ARGS,
  DEV_K1_PRIVATE_KEY,
  DEV_K1_PUBLIC_KEY
} from "./constants.js"
import { type ConfigOptions } from "./Config"

// ---------------------------------------------------------------------------
// Node role types
// ---------------------------------------------------------------------------

export interface BiosNode {
  role: "bios"
  /** Always node index -100 (matching Python launcher). */
  index: -100
  name: "node_bios"
  p2pPort: number
  httpPort: number
  producers: readonly string[]
  enableStaleProduction: true
}

export interface ProducerNode {
  role: "producer"
  index: number
  name: string
  p2pPort: number
  httpPort: number
  producers: readonly string[]
}

export interface OperatorNode {
  role: "operator"
  index: number
  name: string
  p2pPort: number
  httpPort: number
  /** OPP operator nodes run in irreversible read-mode. */
  readMode: "irreversible"
  batchOperatorAccount?: string
  batchEnabled?: boolean
  underwriterAccount?: string
}

export type NodeConfig = BiosNode | ProducerNode | OperatorNode

// ---------------------------------------------------------------------------
// Port assignment (mirrors Python launcher port generators)
// ---------------------------------------------------------------------------

interface PortAllocator {
  nextP2p(): number
  nextHttp(): number
}

function createPortAllocator(baseP2p: number, baseHttp: number): PortAllocator {
  let p2pCount = 0
  let httpCount = 0
  return {
    nextP2p(): number {
      return baseP2p + p2pCount++
    },
    nextHttp(): number {
      return baseHttp + httpCount++
    }
  }
}

// ---------------------------------------------------------------------------
// Producer name generation (mirrors launcher.py producer_name())
// ---------------------------------------------------------------------------

const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"

function alphaStrBase(num: number, base: string): string {
  const d = Math.floor(num / base.length)
  const m = num % base.length
  if (d > 0) {
    return alphaStrBase(d, base) + base[m]
  }
  return base[m]
}

/**
 * Generate a producer account name from its index.
 *
 * First 26: "defproducera" .. "defproducerz".
 * Beyond 26: "defpraaaaaab", "defpraaaaaac", etc.
 */
export function producerName(index: number, shared = false): string {
  const prefix = shared ? "shr" : "def"
  if (index > ASCII_LOWER.length - 1) {
    const suffix = alphaStrBase(
      index - ASCII_LOWER.length + 1,
      ASCII_LOWER
    ).padStart(7, "a")
    return `${prefix}pr${suffix}`
  }
  return `${prefix}producer${ASCII_LOWER[index]}`
}

// ---------------------------------------------------------------------------
// Generation options
// ---------------------------------------------------------------------------

export interface GenerateNodeConfigsOptions {
  /** Number of producer nodes (excluding bios). */
  pnodes: number
  /** Total number of non-bios nodes. 0 or undefined = same as pnodes. */
  totalNodes?: number
  /** Total number of defproducers to distribute across producer nodes. */
  producerCount?: number
  /** Number of additional OPP operator nodes (appended after producer/API nodes). */
  operatorNodes?: number
  /** Override base P2P port (default: 9876). */
  baseP2pPort?: number
  /** Override base HTTP port (default: 8888). */
  baseHttpPort?: number
  /** Hostname for peer addresses (default: "localhost"). */
  hostname?: string
  /** Listen address (default: "0.0.0.0"). */
  listenAddr?: string
  /** Maximum P2P connections from a single host. */
  p2pMaxNodesPerHost?: number
  /** Add HTTP insecure settings to every node. */
  httpInsecure?: boolean
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate node configs for an entire cluster.
 *
 * Returns an array starting with the BiosNode, followed by ProducerNodes,
 * non-producer API nodes, and finally OperatorNodes.
 */
export function generateNodeConfigs(
  opts: GenerateNodeConfigsOptions
): NodeConfig[] {
  const pnodes = opts.pnodes
  const totalNonBios =
    opts.totalNodes && opts.totalNodes > 0 ? opts.totalNodes : pnodes
  const producerCount = opts.producerCount ?? 21
  const operatorCount = opts.operatorNodes ?? 0
  const hostname = opts.hostname ?? "localhost"
  const baseP2p = opts.baseP2pPort ?? BASE_P2P_PORT
  const baseHttp = opts.baseHttpPort ?? BASE_HTTP_PORT

  const allocator = createPortAllocator(baseP2p, baseHttp)
  const configs: NodeConfig[] = []

  // --- Bios node ---
  const biosNode: BiosNode = {
    role: "bios",
    index: -100,
    name: "node_bios",
    p2pPort: BIOS_P2P_PORT,
    httpPort: BIOS_HTTP_PORT,
    producers: ["sysio"],
    enableStaleProduction: true
  }
  configs.push(biosNode)

  // --- Generate defproducer names ---
  const defProducerNames = Array.from({ length: producerCount }, (_, i) =>
    producerName(i)
  )

  // --- Producer nodes (non-consecutive assignment, mirrors launcher.py) ---
  for (let nodeIdx = 0; nodeIdx < pnodes; nodeIdx++) {
    const assigned: string[] = []
    // Calculate how many producers this node gets
    const base = Math.floor(producerCount / pnodes)
    const extra = nodeIdx < producerCount % pnodes ? 1 : 0
    const count = base + extra

    // Assign non-consecutive producers (stride by pnodes)
    let producerIdx = nodeIdx
    let assignedCount = 0
    while (assignedCount < count && producerIdx < defProducerNames.length) {
      assigned.push(defProducerNames[producerIdx])
      producerIdx += pnodes
      assignedCount++
    }

    const nodeNum = nodeIdx
    const pNode: ProducerNode = {
      role: "producer",
      index: nodeNum,
      name: `node_${String(nodeNum).padStart(2, "0")}`,
      p2pPort: allocator.nextP2p(),
      httpPort: allocator.nextHttp(),
      producers: assigned
    }
    configs.push(pNode)
  }

  // --- Non-producer API nodes ---
  for (let i = pnodes; i < totalNonBios; i++) {
    const nodeNum = i
    const apiNode: ProducerNode = {
      role: "producer",
      index: nodeNum,
      name: `node_${String(nodeNum).padStart(2, "0")}`,
      p2pPort: allocator.nextP2p(),
      httpPort: allocator.nextHttp(),
      producers: []
    }
    configs.push(apiNode)
  }

  // --- OPP operator nodes ---
  for (let i = 0; i < operatorCount; i++) {
    const nodeNum = totalNonBios + i
    const opNode: OperatorNode = {
      role: "operator",
      index: nodeNum,
      name: `node_${String(nodeNum).padStart(2, "0")}`,
      p2pPort: allocator.nextP2p(),
      httpPort: allocator.nextHttp(),
      readMode: "irreversible"
    }
    configs.push(opNode)
  }

  return configs
}

// ---------------------------------------------------------------------------
// Convert NodeConfig to ConfigINIOptions
// ---------------------------------------------------------------------------

/**
 * Build a ConfigINIOptions object from a NodeConfig and cluster-level settings.
 */
export function nodeConfigToIniOptions(
  node: NodeConfig,
  opts: {
    biosP2pEndpoint: string
    allPeerEndpoints: readonly string[]
    hostname?: string
    listenAddr?: string
    p2pMaxNodesPerHost?: number
    httpInsecure?: boolean
  }
): ConfigOptions {
  const hostname = opts.hostname ?? "localhost"
  const listenAddr = opts.listenAddr ?? "0.0.0.0"
  const isBios = node.role === "bios"
  const isProducer = node.role === "producer" && node.producers.length > 0
  const isOperator = node.role === "operator"

  // Collect plugins
  const plugins: string[] = [...BASE_PLUGINS]
  if (isProducer || isBios) {
    plugins.push(...PRODUCER_PLUGINS)
  }

  // Collect peer addresses (exclude self)
  const selfEndpoint = `${hostname}:${node.p2pPort}`
  const peerAddresses: string[] = []
  if (!isBios) {
    peerAddresses.push(opts.biosP2pEndpoint)
  }
  for (const ep of opts.allPeerEndpoints) {
    if (ep !== selfEndpoint) {
      peerAddresses.push(ep)
    }
  }

  // Signature providers for producer/bios
  const signatureProviders: string[] = []
  if (isBios) {
    signatureProviders.push(
      `wire-${DEV_K1_PUBLIC_KEY},wire,wire,${DEV_K1_PUBLIC_KEY},KEY:${DEV_K1_PRIVATE_KEY}`
    )
  }

  const iniOpts: ConfigOptions = {
    plugins,
    p2pListenEndpoint: `${listenAddr}:${node.p2pPort}`,
    p2pServerAddress: `${hostname}:${node.p2pPort}`,
    httpServerAddress: `${listenAddr}:${node.httpPort}`,
    p2pPeerAddresses: peerAddresses,
    blocksPath: "blocks",

    // nodeop extra args from cluster_manager
    contractsConsole: true,
    traceNoAbis: true,
    voteThreads: NODEOP_EXTRA_ARGS.voteThreads,
    maxTransactionTime: NODEOP_EXTRA_ARGS.maxTransactionTime,
    abiSerializerMaxTimeMs: NODEOP_EXTRA_ARGS.abiSerializerMaxTimeMs,
    p2pMaxNodesPerHost: opts.p2pMaxNodesPerHost,
    maxClients: NODEOP_EXTRA_ARGS.maxClients,
    connectionCleanupPeriod: NODEOP_EXTRA_ARGS.connectionCleanupPeriod,
    httpMaxResponseTimeMs: NODEOP_EXTRA_ARGS.httpMaxResponseTimeMs,
    httpInsecure: opts.httpInsecure ?? true
  }

  if (isBios) {
    iniOpts.enableStaleProduction = true
    iniOpts.producerNames = node.producers
    iniOpts.signatureProviders = signatureProviders
  } else if (isProducer) {
    iniOpts.producerNames = node.producers
    // Signature providers are injected at runtime from generated keys
  } else if (!isOperator) {
    // Non-producer API node
    iniOpts.transactionRetryMaxStorageSizeGb = 100
  }

  if (isOperator) {
    iniOpts.readMode = node.readMode
    iniOpts.transactionRetryMaxStorageSizeGb = 100
    if (node.batchOperatorAccount) {
      iniOpts.batchOperatorAccount = node.batchOperatorAccount
    }
    if (node.batchEnabled !== undefined) {
      iniOpts.batchEnabled = node.batchEnabled
    }
    if (node.underwriterAccount) {
      iniOpts.underwriterAccount = node.underwriterAccount
    }
  }

  return iniOpts
}

export default NodeConfig
