import Path from "path"
import Fs from "fs"
import { ProcessManager } from "../processes/ProcessManager.js"
import { Clio } from "../clients/Clio.js"
import { log } from "../logger.js"
import { sleep, waitForEndpoint, retry } from "../util.js"
import { generateGenesis } from "./genesis.js"
import { generateConfigFileContent, type ConfigOptions } from "./Config"
import {
  DEV_PRIVATE_KEY,
  DEV_PUBLIC_KEY,
  BIOS_P2P_PORT,
  BIOS_HTTP_PORT,
  P2P_PORT_BASE,
  HTTP_PORT_BASE,
  SYSTEM_ACCOUNTS,
  CONTRACT_PATHS,
  OPP_CONTRACT_PATHS,
  BASE_PLUGINS,
  PRODUCER_PLUGINS,
  BATCH_OPERATOR_PLUGINS,
  UNDERWRITER_PLUGINS,
  batchOperatorAccountName,
  underwriterAccountName,
  devSignatureProvider
} from "./constants.js"
import * as Assert from "node:assert"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterConfig {
  /** Path to wire-sysio build directory */
  buildDir: string
  /** Where to create the cluster data */
  chainDir: string
  /** Number of block producers (default: 21) */
  producerCount: number
  /** Number of non-bios nodes (default: 1) */
  nodeCount: number
  /** Whether to use HTTPS for the HTTP plugin (default: false) */
  httpSecure: boolean
  /** Additional nodeop plugins to enable */
  extraPlugins?: string[]
  /** Number of batch operator nodes (default: 1) */
  batchOperatorCount: number
  /** Number of underwriter nodes (default: 1) */
  underwriterCount: number
  /** Path to wire-sysio source directory (for OPP contracts). Derived from buildDir if not set. */
  sourceDir?: string
}

interface NodeState {
  nodeId: string
  httpPort: number
  p2pPort: number
  dataDir: string
  blocksDir: string
  configPath: string
  isProducer: boolean
  producerName: string | null
  /** Role tag for batch operator / underwriter nodes */
  role?: "producer" | "batch_operator" | "underwriter"
  /** Account name for batch operator or underwriter nodes */
  operatorAccount?: string
}

interface ClusterState {
  config: ClusterConfig
  nodes: NodeState[]
  batchOperatorNodes: NodeState[]
  underwriterNodes: NodeState[]
  biosNode: NodeState
  createdAt: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CLUSTER_CONFIG: Pick<
  ClusterConfig,
  | "producerCount"
  | "nodeCount"
  | "httpSecure"
  | "batchOperatorCount"
  | "underwriterCount"
> = {
  producerCount: 21,
  nodeCount: 1,
  httpSecure: false,
  batchOperatorCount: 1,
  underwriterCount: 1
}

const PID_FILENAME = ".pid"
const STATE_FILENAME = ".cluster_state.json"

// ---------------------------------------------------------------------------
// ClusterManager
// ---------------------------------------------------------------------------

export class ClusterManager {
  private pm: ProcessManager
  private state: ClusterState | null = null

  constructor() {
    this.pm = new ProcessManager()
  }

  // ── Public API ──

  /**
   * Full cluster creation flow:
   * 1. Create directory structure
   * 2. Write genesis.json
   * 3. Generate config.ini for each node
   * 4. Start bios node
   * 5. Run bootstrap sequence
   * 6. Stop bios node
   * 7. Save state
   */
  async create(config: ClusterConfig): Promise<void> {
    const cfg: ClusterConfig = { ...DEFAULT_CLUSTER_CONFIG, ...config }
    const { chainDir, buildDir } = cfg

    log.info(
      `Creating cluster in ${chainDir} (producers=${cfg.producerCount}, nodes=${cfg.nodeCount}, ` +
        `batchOps=${cfg.batchOperatorCount}, underwriters=${cfg.underwriterCount})`
    )

    // 1. Create directory structure
    this.ensureDirectoryStructure(cfg)

    // 2. Write genesis.json
    const genesisPath = Path.join(chainDir, "genesis.json")
    const genesisContent = generateGenesis()
    Fs.writeFileSync(
      genesisPath,
      JSON.stringify(genesisContent, null, 2),
      "utf-8"
    )
    log.info(`Genesis written to ${genesisPath}`)

    // 3. Generate config.ini for each node (bios + producers + batch ops + underwriters)
    this.generateAllConfigs(cfg)

    // 4. Start kiod (wallet daemon) with wallet-dir under chain-dir
    const walletDir = Path.join(chainDir, "wallet")
    const kiodBinary = Path.join(buildDir, "bin", "kiod")
    const kiodPort = 8900
    const kiodUrl = `http://127.0.0.1:${kiodPort}`
    await this.pm.spawn({
      label: "kiod",
      command: kiodBinary,
      args: [
        "--wallet-dir",
        walletDir,
        "--data-dir",
        walletDir,
        "--config-dir",
        walletDir,
        "--unlock-timeout=999999",
        `--http-server-address=127.0.0.1:${kiodPort}`,
        "--http-max-response-time-ms",
        "99999",
        "--verbose-http-errors"
      ],
      cwd: walletDir
    })
    await waitForEndpoint(`${kiodUrl}/v1/wallet/list_wallets`, {
      label: "kiod",
      timeoutMs: 10_000
    })
    log.info("kiod is ready (wallet-dir={})", walletDir)

    // 5. Start bios node
    const biosNodeState = this.buildBiosNodeState(cfg)
    await this.startNode(cfg, biosNodeState, genesisPath)
    const biosHttpUrl = `http://127.0.0.1:${biosNodeState.httpPort}`
    await waitForEndpoint(`${biosHttpUrl}/v1/chain/get_info`, {
      label: "bios-node",
      timeoutMs: 30_000
    })
    log.info("Bios node is ready")

    // 6. Run full bootstrap sequence
    const clio = new Clio({
      binary: Path.join(buildDir, "bin", "clio"),
      url: biosHttpUrl,
      walletUrl: kiodUrl
    })
    const nodeStates = this.buildProducerNodeStates(cfg)
    const batchOpStates = this.buildBatchOperatorNodeStates(cfg)
    const underwriterStates = this.buildUnderwriterNodeStates(cfg)
    await bootstrapChain(
      clio,
      cfg,
      biosHttpUrl,
      nodeStates,
      batchOpStates,
      underwriterStates
    )

    // 7. Stop bios node + kiod
    log.info("Stopping bios node after bootstrap...")
    await this.pm.killAll()
    await sleep(2000)

    // 7. Save state
    const clusterState: ClusterState = {
      config: cfg,
      nodes: nodeStates,
      batchOperatorNodes: batchOpStates,
      underwriterNodes: underwriterStates,
      biosNode: biosNodeState,
      createdAt: new Date().toISOString()
    }
    this.state = clusterState
    this.saveState(cfg.chainDir, clusterState)

    // 8. Write cluster-config.json
    this.writeClusterConfigJson(
      cfg,
      nodeStates,
      batchOpStates,
      underwriterStates
    )

    this.releaseLock(cfg.chainDir)

    log.info("Cluster created and bootstrapped successfully")
    log.info(`Chain directory: ${chainDir}`)
  }

  /**
   * Read saved state and start all nodes.
   */
  async start(): Promise<void> {
    if (!this.state) {
      throw new Error(
        "No cluster state loaded. Call create() or loadState() first."
      )
    }

    const {
      config: cfg,
      nodes,
      batchOperatorNodes,
      underwriterNodes
    } = this.state

    this.acquireLock(cfg.chainDir)
    const allNodes = [
      ...nodes,
      ...(batchOperatorNodes ?? []),
      ...(underwriterNodes ?? [])
    ]
    log.info(`Starting ${allNodes.length} node(s)...`)

    // Start all nodes (they already have chain state, no genesis needed on relaunch)
    for (const nodeState of allNodes) {
      await this.startNode(cfg, nodeState, undefined)
    }

    // Wait for at least one node to be responsive
    if (nodes.length > 0) {
      const firstUrl = `http://127.0.0.1:${nodes[0].httpPort}`
      await waitForEndpoint(`${firstUrl}/v1/chain/get_info`, {
        label: `node-${nodes[0].nodeId}`,
        timeoutMs: 30_000
      })
    }

    log.info("All nodes started")
  }

  /**
   * Graceful SIGTERM to all running nodes.
   */
  async stop(): Promise<void> {
    log.info("Stopping all cluster nodes...")
    await this.pm.killAll()

    if (this.state) {
      this.releaseLock(this.state.config.chainDir)
    }

    log.info("All nodes stopped")
  }

  /**
   * Load cluster state from disk.
   */
  loadState(chainDir: string): void {
    const stateFile = Path.join(chainDir, STATE_FILENAME)
    if (!Fs.existsSync(stateFile)) {
      throw new Error(
        `No cluster state found at ${stateFile}. Run create() first.`
      )
    }
    const raw = Fs.readFileSync(stateFile, "utf-8")
    this.state = JSON.parse(raw) as ClusterState
    log.info(`Loaded cluster state from ${stateFile}`)
  }

  // ── Private: directory structure ──

  private ensureDirectoryStructure(cfg: ClusterConfig): void {
    const { chainDir, nodeCount, batchOperatorCount, underwriterCount } = cfg

    // Create base directories
    const biosDataDir = Path.join(chainDir, "data", "node_bios")
    Fs.mkdirSync(biosDataDir, { recursive: true })
    Fs.mkdirSync(Path.join(biosDataDir, "blocks"), { recursive: true })

    // Producer / API nodes
    for (let i = 0; i < nodeCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_${String(i).padStart(2, "0")}`
      )
      Fs.mkdirSync(nodeDir, { recursive: true })
      Fs.mkdirSync(Path.join(nodeDir, "blocks"), { recursive: true })
    }

    // Batch operator nodes
    for (let i = 0; i < batchOperatorCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_batchop_${String(i).padStart(2, "0")}`
      )
      Fs.mkdirSync(nodeDir, { recursive: true })
      Fs.mkdirSync(Path.join(nodeDir, "blocks"), { recursive: true })
    }

    // Underwriter nodes
    for (let i = 0; i < underwriterCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_uwrit_${String(i).padStart(2, "0")}`
      )
      Fs.mkdirSync(nodeDir, { recursive: true })
      Fs.mkdirSync(Path.join(nodeDir, "blocks"), { recursive: true })
    }

    const walletDir = Path.join(chainDir, "wallet")
    Fs.mkdirSync(walletDir, { recursive: true })

    log.info(`Directory structure created under ${chainDir}`)
  }

  // ── Private: config generation ──

  private generateAllConfigs(cfg: ClusterConfig): void {
    const {
      chainDir,
      nodeCount,
      producerCount,
      httpSecure,
      batchOperatorCount,
      underwriterCount
    } = cfg

    // Port offset: producer nodes use [0..nodeCount-1],
    // batch ops use [nodeCount..nodeCount+batchOperatorCount-1],
    // underwriters use [nodeCount+batchOperatorCount..]
    const totalNodes = nodeCount + batchOperatorCount + underwriterCount

    // Compute peer addresses for all nodes
    const allPeerAddresses: string[] = []
    allPeerAddresses.push(`127.0.0.1:${BIOS_P2P_PORT}`)
    for (let i = 0; i < totalNodes; i++) {
      allPeerAddresses.push(`127.0.0.1:${P2P_PORT_BASE + i}`)
    }

    // Bios node config
    const biosConfigDir = Path.join(chainDir, "data", "node_bios")
    const biosPeers = allPeerAddresses.filter(
      addr => !addr.endsWith(`:${BIOS_P2P_PORT}`)
    )
    const biosConfigOpts: ConfigOptions = {
      plugins: [...BASE_PLUGINS, ...PRODUCER_PLUGINS],
      httpServerAddress: `0.0.0.0:${BIOS_HTTP_PORT}`,
      p2pListenEndpoint: `0.0.0.0:${BIOS_P2P_PORT}`,
      p2pServerAddress: `localhost:${BIOS_P2P_PORT}`,
      producerNames: ["sysio"],
      p2pPeerAddresses: biosPeers,
      httpInsecure: !httpSecure,
      enableStaleProduction: true,
      traceNoAbis: true,
      signatureProviders: [devSignatureProvider()]
    }
    const biosConfigContent = generateConfigFileContent(biosConfigOpts)
    Fs.writeFileSync(
      Path.join(biosConfigDir, "config.ini"),
      biosConfigContent,
      "utf-8"
    )

    // Producer/non-bios node configs
    const producerNames = this.generateProducerNames(producerCount)
    for (let i = 0; i < nodeCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_${String(i).padStart(2, "0")}`
      )
      const httpPort = HTTP_PORT_BASE + i
      const p2pPort = P2P_PORT_BASE + i

      // Assign producers round-robin to nodes
      const assignedProducers = producerNames.filter(
        (_name, idx) => idx % nodeCount === i
      )

      const peers = allPeerAddresses.filter(
        addr => !addr.endsWith(`:${p2pPort}`)
      )
      const isProducer = assignedProducers.length > 0
      const nodePlugins = isProducer
        ? [...BASE_PLUGINS, ...PRODUCER_PLUGINS]
        : [...BASE_PLUGINS]
      const nodeConfigOpts: ConfigOptions = {
        plugins: nodePlugins,
        httpServerAddress: `0.0.0.0:${httpPort}`,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        producerNames: isProducer ? assignedProducers : undefined,
        p2pPeerAddresses: peers,
        httpInsecure: !httpSecure,
        traceNoAbis: true,
        signatureProviders: [devSignatureProvider()]
      }
      const nodeConfigContent = generateConfigFileContent(nodeConfigOpts)
      Fs.writeFileSync(
        Path.join(nodeDir, "config.ini"),
        nodeConfigContent,
        "utf-8"
      )
    }

    // Batch operator node configs
    for (let i = 0; i < batchOperatorCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_batchop_${String(i).padStart(2, "0")}`
      )
      const portOffset = nodeCount + i
      const httpPort = HTTP_PORT_BASE + portOffset
      const p2pPort = P2P_PORT_BASE + portOffset
      const account = batchOperatorAccountName(i)

      const peers = allPeerAddresses.filter(
        addr => !addr.endsWith(`:${p2pPort}`)
      )
      const batchOpPlugins: string[] = [
        ...BASE_PLUGINS,
        ...BATCH_OPERATOR_PLUGINS
      ]
      const batchOpConfigOpts: ConfigOptions = {
        plugins: batchOpPlugins,
        httpServerAddress: `0.0.0.0:${httpPort}`,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        p2pPeerAddresses: peers,
        httpInsecure: !httpSecure,
        traceNoAbis: true,
        signatureProviders: [devSignatureProvider()],
        readMode: "irreversible",
        batchEnabled: true,
        batchOperatorAccount: account
      }
      const batchOpConfigContent = generateConfigFileContent(batchOpConfigOpts)
      Fs.writeFileSync(
        Path.join(nodeDir, "config.ini"),
        batchOpConfigContent,
        "utf-8"
      )
    }

    // Underwriter node configs
    for (let i = 0; i < underwriterCount; i++) {
      const nodeDir = Path.join(
        chainDir,
        "data",
        `node_uwrit_${String(i).padStart(2, "0")}`
      )
      const portOffset = nodeCount + batchOperatorCount + i
      const httpPort = HTTP_PORT_BASE + portOffset
      const p2pPort = P2P_PORT_BASE + portOffset
      const account = underwriterAccountName(i)

      const peers = allPeerAddresses.filter(
        addr => !addr.endsWith(`:${p2pPort}`)
      )
      const uwritPlugins: string[] = [...BASE_PLUGINS, ...UNDERWRITER_PLUGINS]
      const uwritConfigOpts: ConfigOptions = {
        plugins: uwritPlugins,
        httpServerAddress: `0.0.0.0:${httpPort}`,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        p2pPeerAddresses: peers,
        httpInsecure: !httpSecure,
        traceNoAbis: true,
        signatureProviders: [devSignatureProvider()],
        readMode: "irreversible",
        underwriterEnabled: true,
        underwriterAccount: account
      }
      const uwritConfigContent = generateConfigFileContent(uwritConfigOpts)
      Fs.writeFileSync(
        Path.join(nodeDir, "config.ini"),
        uwritConfigContent,
        "utf-8"
      )
    }

    log.info(
      `Generated config.ini for bios + ${nodeCount} producer node(s) + ` +
        `${batchOperatorCount} batch operator(s) + ${underwriterCount} underwriter(s)`
    )
  }

  private generateProducerNames(count: number): string[] {
    const names: string[] = []
    const chars = "abcdefghijklmnopqrstuvwxyz"
    for (let i = 0; i < count; i++) {
      // Producer naming: defproducera, defproducerb, ..., defproducerz
      const suffix = chars[i % chars.length]
      names.push(`defproducer${suffix}`)
    }
    return names
  }

  // ── Private: node state builders ──

  private buildBiosNodeState(cfg: ClusterConfig): NodeState {
    const dataDir = Path.join(cfg.chainDir, "data", "node_bios")
    return {
      nodeId: "bios",
      httpPort: BIOS_HTTP_PORT,
      p2pPort: BIOS_P2P_PORT,
      dataDir,
      blocksDir: Path.join(dataDir, "blocks"),
      configPath: Path.join(dataDir, "config.ini"),
      isProducer: true,
      producerName: "sysio"
    }
  }

  private buildProducerNodeStates(cfg: ClusterConfig): NodeState[] {
    const producerNames = this.generateProducerNames(cfg.producerCount)
    const states: NodeState[] = []

    for (let i = 0; i < cfg.nodeCount; i++) {
      const nodeDir = Path.join(
        cfg.chainDir,
        "data",
        `node_${String(i).padStart(2, "0")}`
      )
      const assignedProducers = producerNames.filter(
        (_name, idx) => idx % cfg.nodeCount === i
      )
      states.push({
        nodeId: String(i).padStart(2, "0"),
        httpPort: HTTP_PORT_BASE + i,
        p2pPort: P2P_PORT_BASE + i,
        dataDir: nodeDir,
        blocksDir: Path.join(nodeDir, "blocks"),
        configPath: Path.join(nodeDir, "config.ini"),
        isProducer: assignedProducers.length > 0,
        producerName: assignedProducers[0] ?? null,
        role: "producer"
      })
    }

    return states
  }

  private buildBatchOperatorNodeStates(cfg: ClusterConfig): NodeState[] {
    const states: NodeState[] = []

    for (let i = 0; i < cfg.batchOperatorCount; i++) {
      const portOffset = cfg.nodeCount + i
      const nodeDir = Path.join(
        cfg.chainDir,
        "data",
        `node_batchop_${String(i).padStart(2, "0")}`
      )
      const account = batchOperatorAccountName(i)
      states.push({
        nodeId: `batchop_${String(i).padStart(2, "0")}`,
        httpPort: HTTP_PORT_BASE + portOffset,
        p2pPort: P2P_PORT_BASE + portOffset,
        dataDir: nodeDir,
        blocksDir: Path.join(nodeDir, "blocks"),
        configPath: Path.join(nodeDir, "config.ini"),
        isProducer: false,
        producerName: null,
        role: "batch_operator",
        operatorAccount: account
      })
    }

    return states
  }

  private buildUnderwriterNodeStates(cfg: ClusterConfig): NodeState[] {
    const states: NodeState[] = []

    for (let i = 0; i < cfg.underwriterCount; i++) {
      const portOffset = cfg.nodeCount + cfg.batchOperatorCount + i
      const nodeDir = Path.join(
        cfg.chainDir,
        "data",
        `node_uwrit_${String(i).padStart(2, "0")}`
      )
      const account = underwriterAccountName(i)
      states.push({
        nodeId: `uwrit_${String(i).padStart(2, "0")}`,
        httpPort: HTTP_PORT_BASE + portOffset,
        p2pPort: P2P_PORT_BASE + portOffset,
        dataDir: nodeDir,
        blocksDir: Path.join(nodeDir, "blocks"),
        configPath: Path.join(nodeDir, "config.ini"),
        isProducer: false,
        producerName: null,
        role: "underwriter",
        operatorAccount: account
      })
    }

    return states
  }

  // ── Private: node lifecycle ──

  private async startNode(
    cfg: ClusterConfig,
    nodeState: NodeState,
    genesisPath: string | undefined
  ): Promise<void> {
    const nodeopBinary = Path.join(cfg.buildDir, "bin", "nodeop")

    // Config dir is per-node under chain-dir — keeps all state isolated
    const configDir = Path.join(nodeState.dataDir, "config")
    Fs.mkdirSync(configDir, { recursive: true })

    const args: string[] = [
      "--config",
      nodeState.configPath,
      "--config-dir",
      configDir,
      "--data-dir",
      nodeState.dataDir,
      "--blocks-dir",
      nodeState.blocksDir
    ]

    if (genesisPath) {
      args.push("--genesis-json", genesisPath)
    } else {
      // Relaunch: allow stale production to catch up
      args.push("--enable-stale-production")
    }

    await this.pm.spawn({
      label: `node-${nodeState.nodeId}`,
      command: nodeopBinary,
      args,
      cwd: nodeState.dataDir
    })

    log.info(
      `Started node ${nodeState.nodeId} (http=${nodeState.httpPort}, p2p=${nodeState.p2pPort})`
    )
  }

  // ── Private: cluster-config.json export ──

  private writeClusterConfigJson(
    cfg: ClusterConfig,
    producerNodes: NodeState[],
    batchOpNodes: NodeState[],
    underwriterNodes: NodeState[]
  ): void {
    const producerNames = this.generateProducerNames(cfg.producerCount)

    const clusterConfigJson = {
      config: {
        producerCount: cfg.producerCount,
        nodeCount: cfg.nodeCount,
        batchOperatorCount: cfg.batchOperatorCount,
        underwriterCount: cfg.underwriterCount,
        producers: producerNames.map((name, idx) => ({
          name,
          httpPort: HTTP_PORT_BASE + (idx % cfg.nodeCount),
          p2pPort: P2P_PORT_BASE + (idx % cfg.nodeCount)
        })),
        nodes: producerNodes.map(n => ({
          label: `node_${n.nodeId}`,
          httpPort: n.httpPort,
          p2pPort: n.p2pPort
        })),
        batchOperators: batchOpNodes.map(n => ({
          account: n.operatorAccount!,
          httpPort: n.httpPort,
          p2pPort: n.p2pPort
        })),
        underwriters: underwriterNodes.map(n => ({
          account: n.operatorAccount!,
          httpPort: n.httpPort,
          p2pPort: n.p2pPort
        }))
      },
      keys: {
        sysio: {
          keys: [
            { type: "WIRE", private: DEV_PRIVATE_KEY, public: DEV_PUBLIC_KEY }
          ]
        },
        ...Object.fromEntries(
          producerNames.map(name => [
            name,
            {
              keys: [
                {
                  type: "WIRE",
                  private: DEV_PRIVATE_KEY,
                  public: DEV_PUBLIC_KEY
                }
              ]
            }
          ])
        ),
        ...Object.fromEntries(
          batchOpNodes.map(n => [
            n.operatorAccount!,
            {
              keys: [
                {
                  type: "WIRE",
                  private: DEV_PRIVATE_KEY,
                  public: DEV_PUBLIC_KEY
                }
              ]
            }
          ])
        ),
        ...Object.fromEntries(
          underwriterNodes.map(n => [
            n.operatorAccount!,
            {
              keys: [
                {
                  type: "WIRE",
                  private: DEV_PRIVATE_KEY,
                  public: DEV_PUBLIC_KEY
                }
              ]
            }
          ])
        )
      }
    }

    const outputPath = Path.join(cfg.chainDir, "cluster-config.json")
    Fs.writeFileSync(
      outputPath,
      JSON.stringify(clusterConfigJson, null, 2),
      "utf-8"
    )
    log.info(`Cluster config exported to ${outputPath}`)
  }

  // ── Private: PID lock ──

  private acquireLock(chainDir: string): void {
    const pidFile = Path.join(chainDir, PID_FILENAME)
    if (Fs.existsSync(pidFile)) {
      const existingPid = parseInt(Fs.readFileSync(pidFile, "utf-8").trim(), 10)
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0)
          throw new Error(
            `Another cluster manager (pid ${existingPid}) is already running on ${chainDir}. ` +
              `Use stop() to terminate it first.`
          )
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ESRCH"
          ) {
            // Stale PID file, safe to overwrite
          } else if (
            err instanceof Error &&
            err.message.includes("Another cluster manager")
          ) {
            throw err
          }
          // else: stale pid
        }
      }
    }
    Fs.writeFileSync(pidFile, String(process.pid), "utf-8")
  }

  private releaseLock(chainDir: string): void {
    const pidFile = Path.join(chainDir, PID_FILENAME)
    if (Fs.existsSync(pidFile)) {
      try {
        const stored = parseInt(Fs.readFileSync(pidFile, "utf-8").trim(), 10)
        if (stored === process.pid) {
          Fs.unlinkSync(pidFile)
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // ── Private: state persistence ──

  private saveState(chainDir: string, state: ClusterState): void {
    const stateFile = Path.join(chainDir, STATE_FILENAME)
    Fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8")
    log.info(`Cluster state saved to ${stateFile}`)
  }
}

// ---------------------------------------------------------------------------
// Bootstrap sequence — 13 phases
// ---------------------------------------------------------------------------

async function bootstrapChain(
  clio: Clio,
  cfg: ClusterConfig,
  biosHttpUrl: string,
  nodeStates: NodeState[],
  batchOpStates: NodeState[],
  underwriterStates: NodeState[]
): Promise<void> {
  log.info("=== Bootstrap sequence starting ===")

  const contractsPath = Path.join(cfg.buildDir, "contracts")
  const libTestingContracts = Path.join(
    cfg.buildDir,
    "libraries",
    "testing",
    "contracts"
  )

  // Derive source dir for OPP contracts (pre-built, checked into source tree).
  // Convention: buildDir is typically <sourceDir>/build/<variant>, so go up 2 levels.
  // Can be overridden via cfg.sourceDir.
  // const sourceDir = cfg.sourceDir ?? Path.resolve(cfg.buildDir, "..", "..")

  // Helper to resolve contract directory (build contracts or lib/testing/contracts)
  function resolveContractDir(contractName: string): string {
    const buildDir = Path.join(contractsPath, contractName)
    if (Fs.existsSync(Path.join(buildDir, `${contractName}.wasm`))) {
      return buildDir
    }
    const libDir = Path.join(libTestingContracts, contractName)
    if (Fs.existsSync(Path.join(libDir, `${contractName}.wasm`))) {
      return libDir
    }
    throw new Error(
      `Contract ${contractName} not found in ${buildDir} or ${libDir}`
    )
  }

  const producerNames: string[] = []
  const chars = "abcdefghijklmnopqrstuvwxyz"
  for (let i = 0; i < cfg.producerCount; i++) {
    producerNames.push(`defproducer${chars[i % chars.length]}`)
  }

  // ── Phase 1: Create wallet, import dev key ──
  log.info("[Phase 1] Creating wallet and importing dev key...")
  await clio.walletCreate("default")
  await clio.walletImportKey("default", DEV_PRIVATE_KEY)
  log.info("[Phase 1] Wallet created, dev key imported")

  // ── Phase 2: Deploy sysio.bios contract ──
  log.info("[Phase 2] Deploying sysio.bios...")
  const biosContractDir = resolveContractDir("sysio.bios")
  await retry(
    () =>
      clio.setContract(
        "sysio",
        biosContractDir,
        "sysio.bios.wasm",
        "sysio.bios.abi"
      ),
    { label: "deploy sysio.bios", maxAttempts: 3, delayMs: 2000 }
  )
  log.info("[Phase 2] sysio.bios deployed")

  // ── Phase 3: Activate ALL protocol features ──
  // In this Wire fork, PREACTIVATE_FEATURE (RESERVED_FIRST_PROTOCOL_FEATURE) is
  // enabled without activation restrictions — it's auto-active. We just need to
  // query all supported features and activate them via the sysio::activate action.
  log.info("[Phase 3] Activating protocol features...")

  const featuresResp = await fetch(
    `${biosHttpUrl}/v1/producer/get_supported_protocol_features`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }
  )
  if (!featuresResp.ok) {
    throw new Error(
      `Failed to get supported protocol features: ${featuresResp.statusText}`
    )
  }

  const featuresBody = (await featuresResp.json()) as {
    payload?: Array<{
      feature_digest: string
      subjective_restrictions?: {
        preactivation_required: boolean
        enabled: boolean
      }
      specification?: Array<{ name: string; value: string }>
    }>
  }
  const features =
    featuresBody.payload ??
    (featuresBody as unknown as Array<{
      feature_digest: string
      specification?: Array<{ name: string; value: string }>
    }>)

  const featureList = Array.isArray(features) ? features : []
  let activatedCount = 0

  for (const feature of featureList) {
    const digest = feature.feature_digest
    if (!digest) continue

    // Skip PREACTIVATE_FEATURE — already active without restrictions
    const codename = feature.specification?.find(
      (s: { name: string }) => s.name === "builtin_feature_codename"
    )?.value
    if (codename === "PREACTIVATE_FEATURE") continue

    try {
      await clio.activateFeature(digest)
      activatedCount++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        !msg.includes("already activated") &&
        !msg.includes("already been activated")
      ) {
        log.warn(
          "[Phase 3] Feature activation issue: {} - {}",
          codename ?? digest,
          msg
        )
      }
    }
  }
  await sleep(1000) // wait for features to take effect in next block
  log.info("[Phase 3] Activated {} protocol features", activatedCount)
  log.info("[Phase 3] Protocol features activated")

  // ── Phase 4: BLS instant finality setup ──
  log.info("[Phase 4] BLS instant finality setup...")
  try {
    // Get finalizer info from producer nodes via the producer API
    const finalizerNodes: Array<{
      description: string
      weight: number
      public_key: string
      pop: string
    }> = []
    for (const nodeState of nodeStates) {
      if (!nodeState.isProducer) continue
      try {
        const nodeUrl = `http://127.0.0.1:${nodeState.httpPort}`
        const finKeyResp = await fetch(
          `${nodeUrl}/v1/producer/get_finalizer_info`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(5000)
          }
        )
        if (finKeyResp.ok) {
          const finInfo = (await finKeyResp.json()) as {
            finalizer_keys?: Array<{
              public_key: string
              proof_of_possession: string
            }>
          }
          if (finInfo.finalizer_keys && finInfo.finalizer_keys.length > 0) {
            const key = finInfo.finalizer_keys[0]
            finalizerNodes.push({
              description: `finalizer-${nodeState.nodeId}`,
              weight: 1,
              public_key: key.public_key,
              pop: key.proof_of_possession
            })
          }
        }
      } catch {
        log.debug(`Could not get finalizer info from node ${nodeState.nodeId}`)
      }
    }

    if (finalizerNodes.length > 0) {
      const threshold = Math.floor((finalizerNodes.length * 2) / 3) + 1
      const setFinData = JSON.stringify({
        finalizer_policy: {
          threshold,
          finalizers: finalizerNodes
        }
      })
      await clio.pushAction("sysio", "setfinalizer", setFinData, "sysio@active")
      log.info(
        `[Phase 4] Set ${finalizerNodes.length} finalizers (threshold=${threshold})`
      )
    } else {
      log.info(
        "[Phase 4] No finalizer keys available, skipping instant finality"
      )
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`[Phase 4] Instant finality setup failed (non-fatal): ${msg}`)
  }

  // ── Phase 5: Create producer accounts ──
  log.info("[Phase 5] Creating producer accounts...")
  for (const name of producerNames) {
    await retry(
      () => clio.createAccount("sysio", name, DEV_PUBLIC_KEY, DEV_PUBLIC_KEY),
      { label: `create account ${name}`, maxAttempts: 3, delayMs: 1000 }
    )
    log.debug(`Created producer account: ${name}`)
  }
  log.info(`[Phase 5] Created ${producerNames.length} producer accounts`)

  // ── Phase 6: Create system accounts ──
  log.info("[Phase 6] Creating system accounts...")
  for (const acctName of SYSTEM_ACCOUNTS) {
    try {
      await clio.createSystemAccount(acctName, DEV_PUBLIC_KEY)
      log.debug(`Created system account: ${acctName}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("already exists")) {
        log.debug(`Account ${acctName} already exists`)
      } else {
        throw new Error(`Failed to create system account ${acctName}: ${msg}`)
      }
    }
  }
  log.info(`[Phase 6] Created ${SYSTEM_ACCOUNTS.length} system accounts`)

  // ── Phase 7: Deploy sysio.system + setpriv ──
  log.info("[Phase 7] Deploying sysio.system...")
  const systemContractDir = resolveContractDir("sysio.system")
  await retry(
    () =>
      clio.setContract(
        "sysio",
        systemContractDir,
        "sysio.system.wasm",
        "sysio.system.abi"
      ),
    { label: "deploy sysio.system", maxAttempts: 3, delayMs: 2000 }
  )
  log.info("[Phase 7] sysio.system deployed")

  // ── Phase 8: Set producers + handoff validation ──
  log.info("[Phase 8] Setting producers...")
  const prodSchedule = producerNames.slice(0, 21).map(name => ({
    producer_name: name,
    block_signing_key: DEV_PUBLIC_KEY
  }))
  await clio.pushAction(
    "sysio",
    "setprodkeys",
    JSON.stringify({ schedule: prodSchedule }),
    "sysio@active"
  )

  log.info("[Phase 8] Waiting for producer handoff (timeout 90s)...")
  const handoffDeadline = Date.now() + 90_000
  let handoffComplete = false
  while (Date.now() < handoffDeadline) {
    try {
      const info = await clio.getInfo()
      if (info.head_block_producer && info.head_block_producer !== "sysio") {
        log.info(
          `[Phase 8] Producer handoff complete: ${info.head_block_producer as string} is producing`
        )
        handoffComplete = true
        break
      }
    } catch {
      log.error("[Phase 8] Producer handoff check failed, retrying...")
    }
    await sleep(1000)
  }

  Assert.ok(
    handoffComplete,
    "Block production handoff to scheduled producers failed within 90s"
  )

  // ── Phase 9: Deploy sysio.token + setpriv ──
  log.info("[Phase 9] Deploying sysio.token...")
  const tokenContractDir = resolveContractDir("sysio.token")
  await retry(
    () =>
      clio.setContract(
        "sysio.token",
        tokenContractDir,
        "sysio.token.wasm",
        "sysio.token.abi"
      ),
    { label: "deploy sysio.token", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.token")
  log.info("[Phase 9] sysio.token deployed and set privileged")

  // ── Phase 10: Create/issue/distribute tokens ──
  log.info("[Phase 10] Creating and distributing tokens...")

  // Create token (1 billion SYS)
  await clio.pushAction(
    "sysio.token",
    "create",
    JSON.stringify({
      issuer: "sysio",
      maximum_supply: "1000000000.0000 SYS"
    }),
    "sysio.token@active"
  )

  // Issue all tokens to sysio
  await clio.pushAction(
    "sysio.token",
    "issue",
    JSON.stringify({
      to: "sysio",
      quantity: "1000000000.0000 SYS",
      memo: "initial issue"
    }),
    "sysio@active"
  )

  // Transfer 1M SYS to each producer
  for (const name of producerNames) {
    await clio.pushAction(
      "sysio.token",
      "transfer",
      JSON.stringify({
        from: "sysio",
        to: name,
        quantity: "1000000.0000 SYS",
        memo: "init transfer"
      }),
      "sysio@active"
    )
    log.debug(`Transferred 1,000,000 SYS to ${name}`)
  }
  log.info("[Phase 10] Tokens created, issued, and distributed")

  // ── Phase 11: Deploy sysio.roa + setpriv + activate ──
  log.info("[Phase 11] Deploying sysio.roa...")
  const roaContractDir = resolveContractDir("sysio.roa")
  await retry(
    () =>
      clio.setContract(
        "sysio.roa",
        roaContractDir,
        "sysio.roa.wasm",
        "sysio.roa.abi"
      ),
    { label: "deploy sysio.roa", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.roa")

  // Activate ROA
  await clio.pushAction(
    "sysio.roa",
    "activateroa",
    JSON.stringify({
      total_sys: "75496.0000 SYS",
      bytes_per_unit: "104"
    }),
    "sysio.roa@active"
  )
  log.info("[Phase 11] sysio.roa deployed, privileged, and activated")

  // ── Phase 12: Deploy sysio.authex + setpriv + auth update ──
  log.info("[Phase 12] Deploying sysio.authex...")
  const authexContractDir = resolveContractDir("sysio.authex")
  await retry(
    () =>
      clio.setContract(
        "sysio.authex",
        authexContractDir,
        "sysio.authex.wasm",
        "sysio.authex.abi"
      ),
    { label: "deploy sysio.authex", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.authex")

  // Update auth: grant sysio.authex code permission on its own owner
  await clio.pushAction(
    "sysio",
    "updateauth",
    JSON.stringify({
      account: "sysio.authex",
      permission: "owner",
      parent: "",
      auth: {
        threshold: 1,
        keys: [
          {
            key: DEV_PUBLIC_KEY,
            weight: 1
          }
        ],
        accounts: [
          {
            permission: {
              actor: "sysio.authex",
              permission: "sysio.code"
            },
            weight: 1
          }
        ],
        waits: []
      }
    }),
    "sysio.authex@owner"
  )
  log.info("[Phase 12] sysio.authex deployed, privileged, and auth updated")

  // ── Phase 13: System init ──
  log.info("[Phase 13] Initializing system contract...")
  await clio.pushAction(
    "sysio",
    "init",
    JSON.stringify({ version: 0, core: "4,SYS" }),
    "sysio@active"
  )
  log.info("[Phase 13] System initialized (version:0, core:4,SYS)")

  // ── Phase 14: Deploy OPP contracts ──
  log.info("[Phase 14] Deploying OPP contracts...")
  for (const [contractName, relPath] of Object.entries(OPP_CONTRACT_PATHS)) {
    const contractDir = Path.join(cfg.buildDir, relPath),
      wasmFile = `${contractName}.wasm`,
      abiFile = `${contractName}.abi`

    if (!Fs.existsSync(Path.join(contractDir, wasmFile))) {
      log.warn(
        `[Phase 14] OPP contract ${contractName} not found at ${contractDir}, skipping`
      )
      continue
    }
    await retry(
      () => clio.setContract(contractName, contractDir, wasmFile, abiFile),
      { label: `deploy ${contractName}`, maxAttempts: 3, delayMs: 2000 }
    )
    log.info(`[Phase 14] Deployed ${contractName}`)
  }
  log.info("[Phase 14] OPP contracts deployed")

  // ── Phase 15: Configure sysio.epoch ──
  log.info("[Phase 15] Configuring sysio.epoch...")
  await clio.pushAction(
    "sysio.epoch",
    "setconfig",
    JSON.stringify({
      epoch_duration_sec: 360,
      operators_per_epoch: 7,
      batch_operator_minimum_active: cfg.batchOperatorCount,
      batch_op_groups: 3,
      warmup_epochs: 1,
      cooldown_epochs: 1
    }),
    "sysio.epoch@active"
  )
  log.info("[Phase 15] sysio.epoch configured")

  // ── Phase 16: Register outposts ──
  log.info("[Phase 16] Registering outposts...")
  // ETH outpost: chain_kind=2, chain_id=31337 (local anvil)
  await clio.pushAction(
    "sysio.epoch",
    "regoutpost",
    JSON.stringify({ chain_kind: 2, chain_id: 31337 }),
    "sysio.epoch@active"
  )
  // SOL outpost: chain_kind=3, chain_id=0 (local validator)
  await clio.pushAction(
    "sysio.epoch",
    "regoutpost",
    JSON.stringify({ chain_kind: 3, chain_id: 0 }),
    "sysio.epoch@active"
  )
  log.info(
    "[Phase 16] Outposts registered (ETH chain_id=31337, SOL chain_id=0)"
  )

  // ── Phase 17: Configure sysio.uwrit ──
  log.info("[Phase 17] Configuring sysio.uwrit...")
  await clio.pushAction(
    "sysio.uwrit",
    "setconfig",
    JSON.stringify({
      fee_bps: 10,
      confirm_lock_sec: 86400,
      uw_fee_share_pct: 50,
      other_uw_share_pct: 25,
      batch_op_share_pct: 25
    }),
    "sysio.uwrit@active"
  )
  log.info("[Phase 17] sysio.uwrit configured")

  // ── Phase 18: Register batch operators ──
  log.info("[Phase 18] Registering batch operators...")
  for (const batchOp of batchOpStates) {
    const account = batchOp.operatorAccount!
    // Create account if needed (may already exist as a system account)
    try {
      await clio.createAccount("sysio", account, DEV_PUBLIC_KEY, DEV_PUBLIC_KEY)
      log.debug(`Created batch operator account: ${account}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("already exists")) {
        throw new Error(
          `Failed to create batch operator account ${account}: ${msg}`
        )
      }
    }
    // Register as operator type=2 (BATCH)
    await clio.pushAction(
      "sysio.epoch",
      "regoperator",
      JSON.stringify({ operator: account, type: 2 }),
      `${account}@active`
    )
    log.debug(`Registered batch operator: ${account}`)
  }
  log.info(`[Phase 18] Registered ${batchOpStates.length} batch operator(s)`)

  // ── Phase 19: Register underwriters ──
  log.info("[Phase 19] Registering underwriters...")
  for (const uw of underwriterStates) {
    const account = uw.operatorAccount!
    // Create account if needed
    try {
      await clio.createAccount("sysio", account, DEV_PUBLIC_KEY, DEV_PUBLIC_KEY)
      log.debug(`Created underwriter account: ${account}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("already exists")) {
        throw new Error(
          `Failed to create underwriter account ${account}: ${msg}`
        )
      }
    }
    // Register as operator type=3 (UNDERWRITER)
    await clio.pushAction(
      "sysio.epoch",
      "regoperator",
      JSON.stringify({ operator: account, type: 3 }),
      `${account}@active`
    )
    log.debug(`Registered underwriter: ${account}`)
  }
  log.info(`[Phase 19] Registered ${underwriterStates.length} underwriter(s)`)

  log.info("=== Bootstrap sequence complete ===")
}

export default ClusterManager
