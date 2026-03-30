/**
 * Cluster lifecycle manager for Wire e2e tests.
 *
 * Mirrors the Python `wire-sysio/tools/cluster_manager.py` behavior:
 *   - Generates K1 + BLS keys per node (via clio / sys-util)
 *   - Writes `start.cmd`, `logging.json`, `genesis.json` per node
 *   - Writes default `config.ini` with HTTP insecure settings appended
 *   - Launches nodes by executing the start.cmd args
 *   - Runs the full bootstrap sequence (contract deployment, accounts, tokens)
 *   - Persists state to `.cluster_state.json` for relaunch via `run`
 */

import Path from "path"
import Fs from "fs"
import { ProcessManager } from "../processes/ProcessManager.js"
import { AnvilManager } from "../processes/AnvilManager.js"
import { SolanaValidatorManager } from "../processes/SolanaValidatorManager.js"
import { Clio } from "../clients/Clio.js"
import { log } from "../logger.js"
import { sleep, waitForEndpoint, retry, mkdirs } from "../util.js"
import { generateGenesis } from "./genesis.js"
import {
  generateNodeKeySet,
  BIOS_K1_KEY,
  BIOS_BLS_KEY,
  formatK1SignatureProvider,
  formatBLSSignatureProvider,
  type NodeKeySet
} from "./keyGen.js"
import { buildStartCmd, buildRelaunchCmd } from "./startCmd.js"
import { generateLoggingConfig } from "./loggingConfig.js"
import {
  DEV_K1_PRIVATE_KEY,
  DEV_K1_PUBLIC_KEY,
  BIOS_P2P_PORT,
  BIOS_HTTP_PORT,
  BASE_HTTP_PORT,
  BASE_P2P_PORT,
  SYSTEM_ACCOUNTS,
  OPP_CONTRACT_PATHS,
  batchOperatorAccountName,
  underwriterAccountName
} from "./constants.js"
import * as Assert from "node:assert"
import { SystemContracts } from "@wireio/sdk-core"
import { range } from "lodash"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterConfig {
  buildDir: string
  chainDir: string
  producerCount: number
  nodeCount: number
  httpSecure: boolean
  extraPlugins?: string[]
  batchOperatorCount: number
  underwriterCount: number
  sourceDir?: string
}

interface NodeState {
  nodeId: string | number
  host: string
  port: number
  dataDir: string
  configDir: string
  cmd: string[]
  isProducer: boolean
  producerName: string | null
  role?: "producer" | "batch_operator" | "underwriter"
  operatorAccount?: string
}

interface ClusterState {
  pnodes: number
  totalNodes: number
  prodCount: number
  topo: string
  nodes: NodeState[]
  batchOperatorNodes: NodeState[]
  underwriterNodes: NodeState[]
  anvilStateDir: string
  solanaLedgerDir: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = ".cluster_state.json"

/** Default config.ini content (the full default template) + HTTP insecure patch. */
const HTTP_INSECURE_INI = `
# -- http-insecure settings (cluster_manager) --
# Specify the Access-Control-Allow-Origin to be returned on each request (sysio::http_plugin)
access-control-allow-origin = *
# Specify the Access-Control-Allow-Headers to be returned on each request (sysio::http_plugin)
access-control-allow-headers = *
# Append the error log to HTTP responses (sysio::http_plugin)
verbose-http-errors = true
# If set to false, then any incoming "Host" header is considered valid (sysio::http_plugin)
http-validate-host = false
`

function toProducerName(index: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz"
  return `defproducer${chars[index % chars.length]}`
}

// ---------------------------------------------------------------------------
// ClusterManager
// ---------------------------------------------------------------------------

export class ClusterManager {
  private state: ClusterState | null = null
  get chainPath() {
    return this.config.chainDir
  }

  toDataPath(...paths: string[]): string {
    return Path.join(this.chainPath, "data", ...paths)
  }

  constructor(readonly config: ClusterConfig) {}
  /**
   * Create a new cluster: generate keys, write start.cmd / logging.json /
   * genesis.json per node, start all nodes, run the full bootstrap sequence,
   * then shut everything down and persist state for later `start()`.
   */
  async create(): Promise<void> {
    const cfg = { ...this.config },
      { chainDir, buildDir } = cfg

    const nodeopBinary = Path.join(buildDir, "bin", "nodeop"),
      kiodBinary = Path.join(buildDir, "bin", "kiod"),
      kiodPort = ClusterManager.KiodPort,
      kiodUrl = `http://127.0.0.1:${kiodPort}`,
      dataPath = Path.join(chainDir, "data"),
      walletDir = Path.join(chainDir, "wallet"),
      launchTime = new Date().toISOString().replace("Z", "").slice(0, 23)

    log.info(
      `Creating cluster in ${chainDir} (producers=${cfg.producerCount}, nodes=${cfg.nodeCount}, ` +
        `batchOps=${cfg.batchOperatorCount}, underwriters=${cfg.underwriterCount})`
    )

    // ── 1. Directory structure ──
    Array<string>(
      ClusterManager.AnvilStateSubdir,
      ClusterManager.SolanaLedgerSubdir,
      ClusterManager.BiosNodeDir,
      ...range(cfg.nodeCount).map(i => ClusterManager.toProducerNodePath(i)),
      ...range(cfg.batchOperatorCount).map(i =>
        ClusterManager.toBatchOpNodePath(i)
      ),
      ...range(cfg.underwriterCount).map(i =>
        ClusterManager.toUnderwriterNodePath(i)
      )
    )
      .map(childPath => this.toDataPath(childPath))
      .forEach(mkdirs)

    mkdirs(walletDir)

    // ── 2. Start kiod + create wallet FIRST (keys go in as they're generated) ──

    await ProcessManager.get().spawn({
      label: "kiod",
      command: kiodBinary,
      args: [
        "--wallet-dir",
        walletDir,
        "--data-dir",
        walletDir,
        "--config-dir",
        walletDir,
        `--unlock-timeout=${ClusterManager.KiodUnlockTimeout}`,
        `--http-server-address=127.0.0.1:${kiodPort}`,
        "--http-max-response-time-ms",
        String(ClusterManager.KiodHttpMaxResponseTimeMs),
        "--verbose-http-errors"
      ],
      cwd: walletDir
    })
    await waitForEndpoint(`${kiodUrl}/v1/wallet/list_wallets`, {
      label: "kiod",
      timeoutMs: ClusterManager.KiodStartupTimeoutMs
    })

    const clioBin = Path.join(buildDir, "bin", "clio")
    const clioWallet = new Clio({
      binary: clioBin,
      url: ClusterManager.ClioFallbackUrl,
      walletUrl: kiodUrl
    })
    await clioWallet.walletCreate("default")

    // Import bios keys immediately
    await clioWallet.walletImportKey("default", BIOS_K1_KEY.privateKey)
    await clioWallet.walletImportKey("default", BIOS_BLS_KEY.privateKey)
    log.info("kiod ready, wallet created, bios keys imported")

    // ── 3. Generate keys (each imported into wallet immediately) ──
    log.info("Generating node keys (K1 + BLS)...")
    const nodeKeys: NodeKeySet[] = []
    for (let i = 0; i < cfg.nodeCount; i++) {
      const keys = await generateNodeKeySet(buildDir)
      await clioWallet.walletImportKey("default", keys.k1.privateKey)
      await clioWallet.walletImportKey("default", keys.bls.privateKey)
      nodeKeys.push(keys)
    }
    // Generate keys for batch operator nodes
    const batchOpKeys: NodeKeySet[] = []
    for (let i = 0; i < cfg.batchOperatorCount; i++) {
      const keys = await generateNodeKeySet(buildDir)
      await clioWallet.walletImportKey("default", keys.k1.privateKey)
      await clioWallet.walletImportKey("default", keys.bls.privateKey)
      batchOpKeys.push(keys)
    }
    // Generate keys for underwriter nodes
    const uwKeys: NodeKeySet[] = []
    for (let i = 0; i < cfg.underwriterCount; i++) {
      const keys = await generateNodeKeySet(buildDir)
      await clioWallet.walletImportKey("default", keys.k1.privateKey)
      await clioWallet.walletImportKey("default", keys.bls.privateKey)
      uwKeys.push(keys)
    }
    log.info(
      `Generated and imported keys for ${cfg.nodeCount} producer(s), ${cfg.batchOperatorCount} batch op(s), ${cfg.underwriterCount} underwriter(s)`
    )

    // ── 3. Build producer name assignments (mirrors Python bind_nodes) ──
    const allProducerNames: string[] = []
    for (let i = 0; i < cfg.producerCount; i++) {
      allProducerNames.push(toProducerName(i))
    }
    // Assign producers round-robin across nodes (non-consecutive, matching Python)
    const nodeProducers: string[][] = Array.from(
      { length: cfg.nodeCount },
      () => []
    )
    for (let i = 0; i < allProducerNames.length; i++) {
      nodeProducers[i % cfg.nodeCount].push(allProducerNames[i])
    }

    // ── 4. Peer addresses ──
    const biosP2P = `localhost:${BIOS_P2P_PORT}`
    const allPeerAddresses: string[] = [biosP2P]
    for (let i = 0; i < cfg.nodeCount; i++) {
      allPeerAddresses.push(`localhost:${BASE_P2P_PORT + i}`)
    }

    // ── 5. Write per-node files (genesis, logging, start.cmd, config.ini) ──
    const genesis = generateGenesis({
      initialFinalizerKey: BIOS_BLS_KEY.publicKey
    })
    const loggingJson = JSON.stringify(generateLoggingConfig(), null, 2)

    // Helper: write node files
    const writeNodeFiles = (nodeDir: string, cmd: string[]) => {
      const genesisPath = Path.join(nodeDir, "genesis.json")
      Fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2))
      Fs.writeFileSync(Path.join(nodeDir, "logging.json"), loggingJson)
      Fs.writeFileSync(Path.join(nodeDir, "start.cmd"), cmd.join(" "))
      // Write default config.ini with HTTP insecure patch (matches Python _patch_configs_http_insecure)
      const defaultIniPath = Path.join(
        buildDir,
        "etc",
        "sysio",
        ClusterManager.BiosNodeDir,
        "config.ini"
      )
      let configIni = ""
      if (Fs.existsSync(defaultIniPath)) {
        configIni = Fs.readFileSync(defaultIniPath, "utf-8")
      }
      configIni += HTTP_INSECURE_INI
      Fs.writeFileSync(Path.join(nodeDir, "config.ini"), configIni)
    }

    // ── 5a. Bios node ──
    const biosDir = Path.join(dataPath, ClusterManager.BiosNodeDir)
    const biosGenesisPath = Path.join(biosDir, "genesis.json")
    const biosCmd = buildStartCmd({
      nodeopBinary,
      p2pListenEndpoint: `0.0.0.0:${BIOS_P2P_PORT}`,
      p2pServerAddress: `localhost:${BIOS_P2P_PORT}`,
      p2pPeerAddresses: [],
      httpServerAddress: `localhost:${BIOS_HTTP_PORT}`,
      enableStaleProduction: true,
      producerNames: ["sysio"],
      k1Keys: [BIOS_K1_KEY],
      blsKeys: [BIOS_BLS_KEY],
      configDir: biosDir,
      dataDir: biosDir,
      genesisJson: biosGenesisPath,
      genesisTimestamp: launchTime,
      p2pMaxNodesPerHost: cfg.nodeCount + 1
    })
    writeNodeFiles(biosDir, biosCmd)

    // ── 5b. Producer nodes ──
    const nodeStates: NodeState[] = []
    for (let i = 0; i < cfg.nodeCount; i++) {
      const nodeDir = Path.join(dataPath, ClusterManager.toProducerNodePath(i))
      const nodeGenesisPath = Path.join(nodeDir, "genesis.json")
      const httpPort = BASE_HTTP_PORT + i
      const p2pPort = BASE_P2P_PORT + i
      const peers = allPeerAddresses.filter(a => a !== `localhost:${p2pPort}`)
      const keys = nodeKeys[i]

      const cmd = buildStartCmd({
        nodeopBinary,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        p2pPeerAddresses: peers,
        httpServerAddress: `localhost:${httpPort}`,
        producerNames: nodeProducers[i],
        k1Keys: [keys.k1],
        blsKeys: [keys.bls],
        configDir: nodeDir,
        dataDir: nodeDir,
        genesisJson: nodeGenesisPath,
        genesisTimestamp: launchTime,
        p2pMaxNodesPerHost: cfg.nodeCount + 1
      })
      writeNodeFiles(nodeDir, cmd)

      nodeStates.push({
        nodeId: i,
        host: "localhost",
        port: httpPort,
        dataDir: nodeDir,
        configDir: nodeDir,
        cmd,
        isProducer: nodeProducers[i].length > 0,
        producerName: nodeProducers[i][0] ?? null
      })
    }

    // ── 5c. Batch operator nodes (read-mode=irreversible, no producer_plugin) ──
    const batchOpStates: NodeState[] = []
    for (let i = 0; i < cfg.batchOperatorCount; i++) {
      const portOffset = cfg.nodeCount + i
      const nodeDir = Path.join(dataPath, ClusterManager.toBatchOpNodePath(i))
      const nodeGenesisPath = Path.join(nodeDir, "genesis.json")
      const httpPort = BASE_HTTP_PORT + portOffset
      const p2pPort = BASE_P2P_PORT + portOffset
      const peers = allPeerAddresses.filter(a => a !== `localhost:${p2pPort}`)
      const keys = batchOpKeys[i]
      const account = batchOperatorAccountName(i)

      const cmd = buildStartCmd({
        nodeopBinary,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        p2pPeerAddresses: peers,
        httpServerAddress: `localhost:${httpPort}`,
        producerNames: [], // no producer plugin
        k1Keys: [keys.k1],
        blsKeys: [keys.bls],
        configDir: nodeDir,
        dataDir: nodeDir,
        genesisJson: nodeGenesisPath,
        genesisTimestamp: launchTime,
        p2pMaxNodesPerHost:
          cfg.nodeCount + cfg.batchOperatorCount + cfg.underwriterCount + 1,
        extraArgs: ["--read-mode", "irreversible"]
      })
      writeNodeFiles(nodeDir, cmd)

      batchOpStates.push({
        nodeId: `batchop_${ClusterManager.padIndex(i)}`,
        host: "localhost",
        port: httpPort,
        dataDir: nodeDir,
        configDir: nodeDir,
        cmd,
        isProducer: false,
        producerName: null,
        role: "batch_operator",
        operatorAccount: account
      })
    }

    // ── 5d. Underwriter nodes (read-mode=irreversible, no producer_plugin) ──
    const underwriterStates: NodeState[] = []
    for (let i = 0; i < cfg.underwriterCount; i++) {
      const portOffset = cfg.nodeCount + cfg.batchOperatorCount + i
      const nodeDir = Path.join(
        dataPath,
        ClusterManager.toUnderwriterNodePath(i)
      )
      const nodeGenesisPath = Path.join(nodeDir, "genesis.json")
      const httpPort = BASE_HTTP_PORT + portOffset
      const p2pPort = BASE_P2P_PORT + portOffset
      const peers = allPeerAddresses.filter(a => a !== `localhost:${p2pPort}`)
      const keys = uwKeys[i]
      const account = underwriterAccountName(i)

      const cmd = buildStartCmd({
        nodeopBinary,
        p2pListenEndpoint: `0.0.0.0:${p2pPort}`,
        p2pServerAddress: `localhost:${p2pPort}`,
        p2pPeerAddresses: peers,
        httpServerAddress: `localhost:${httpPort}`,
        producerNames: [], // no producer plugin
        k1Keys: [keys.k1],
        blsKeys: [keys.bls],
        configDir: nodeDir,
        dataDir: nodeDir,
        genesisJson: nodeGenesisPath,
        genesisTimestamp: launchTime,
        p2pMaxNodesPerHost:
          cfg.nodeCount + cfg.batchOperatorCount + cfg.underwriterCount + 1,
        extraArgs: ["--read-mode", "irreversible"]
      })
      writeNodeFiles(nodeDir, cmd)

      underwriterStates.push({
        nodeId: `uwrit_${ClusterManager.padIndex(i)}`,
        host: "localhost",
        port: httpPort,
        dataDir: nodeDir,
        configDir: nodeDir,
        cmd,
        isProducer: false,
        producerName: null,
        role: "underwriter",
        operatorAccount: account
      })
    }

    log.info(
      `Generated files for bios + ${cfg.nodeCount} producer(s) + ${cfg.batchOperatorCount} batch op(s) + ${cfg.underwriterCount} underwriter(s)`
    )

    // ── 6. Start bios node ──
    await this.launchFromCmd("node-bios", biosCmd, biosDir)
    const biosHttpUrl = `http://127.0.0.1:${BIOS_HTTP_PORT}`
    await waitForEndpoint(`${biosHttpUrl}/v1/chain/get_info`, {
      label: "bios-node",
      timeoutMs: ClusterManager.NodeStartupTimeoutMs
    })
    log.info("Bios node is ready")

    // ── 8. Start producer nodes ──
    for (const ns of nodeStates) {
      await this.launchFromCmd(`node-${ns.nodeId}`, ns.cmd, ns.dataDir)
      await sleep(ClusterManager.NodeStartDelayMs) // stagger starts (matches Python delay=2)
    }
    // Wait for all to sync to block 1
    for (const ns of nodeStates) {
      const nodeUrl = `http://127.0.0.1:${ns.port}`
      await waitForEndpoint(`${nodeUrl}/v1/chain/get_info`, {
        label: `node-${ns.nodeId}`,
        timeoutMs: ClusterManager.NodeStartupTimeoutMs
      })
    }
    log.info(`All ${cfg.nodeCount} producer node(s) are ready`)

    // ── 9. Bootstrap ──
    const clio = new Clio({
      binary: Path.join(buildDir, "bin", "clio"),
      url: biosHttpUrl,
      walletUrl: kiodUrl
    })

    await bootstrapChain(
      clio,
      cfg,
      biosHttpUrl,
      nodeStates,
      batchOpStates,
      underwriterStates
    )

    // ── 10. Kill bios node (not needed after bootstrap) ──
    log.info("Killing bios node (not needed after bootstrap)...")
    const biosHandle = ProcessManager.get().get("node-bios")
    if (biosHandle) await biosHandle.kill()

    // ── 11. Persist state (bios excluded, matching Python _save_state) ──
    const clusterState: ClusterState = {
      pnodes: cfg.nodeCount,
      totalNodes: cfg.nodeCount,
      prodCount: cfg.producerCount,
      topo: "mesh",
      nodes: nodeStates,
      batchOperatorNodes: batchOpStates,
      underwriterNodes: underwriterStates,
      anvilStateDir: Path.join(dataPath, ClusterManager.AnvilStateSubdir),
      solanaLedgerDir: Path.join(dataPath, ClusterManager.SolanaLedgerSubdir)
    }
    this.state = clusterState
    this.saveState(chainDir, clusterState)

    // ── 12. Shut everything down ──
    log.info("Shutting down remaining nodes...")
    await ProcessManager.get().killAll()
    await sleep(ClusterManager.ShutdownDelayMs)

    log.info(`Cluster created and bootstrapped: ${chainDir}`)
  }

  /**
   * Start all nodes from previously saved cluster state (the `run` command).
   * Strips --genesis-json/--genesis-timestamp and adds --enable-stale-production.
   */
  async start(): Promise<void> {
    if (!this.state) {
      throw new Error(
        "No cluster state loaded. Call create() or loadState() first."
      )
    }

    log.info(`Starting ${this.state.nodes.length} nodes...`)

    for (const ns of this.state.nodes) {
      const relaunchCmd = buildRelaunchCmd(ns.cmd)
      const launchTime = new Date()
        .toISOString()
        .replace(/[:.]/g, "_")
        .slice(0, 19)

      // Set up log files (matches Python _run_cluster)
      const outFile = Path.join(ns.dataDir, "stdout.txt")
      const errFile = Path.join(ns.dataDir, `stderr.${launchTime}.txt`)
      const errLink = Path.join(ns.dataDir, "stderr.txt")

      log.info(
        `  Starting node ${ns.nodeId} (port ${ns.port}): ${ns.producerName ?? "non-producer"}`
      )
      await ProcessManager.get().spawn({
        label: `node-${ns.nodeId}`,
        command: relaunchCmd[0],
        args: relaunchCmd.slice(1),
        cwd: ns.dataDir
      })

      // Create stderr symlink
      try {
        Fs.unlinkSync(errLink)
      } catch {}
      try {
        Fs.symlinkSync(Path.basename(errFile), errLink)
      } catch {}
    }

    // Wait for nodes
    for (const ns of this.state.nodes) {
      const url = `http://127.0.0.1:${ns.port}`
      await waitForEndpoint(`${url}/v1/chain/get_info`, {
        label: `node-${ns.nodeId}`,
        timeoutMs: ClusterManager.NodeStartupTimeoutMs
      })
    }
    log.info(`Producer nodes started (${this.state.nodes.length})`)

    // Start batch operator nodes
    for (const ns of this.state.batchOperatorNodes ?? []) {
      const relaunchCmd = buildRelaunchCmd(ns.cmd)
      log.info(
        `  Starting batch op ${ns.nodeId} (port ${ns.port}): ${ns.operatorAccount}`
      )
      await ProcessManager.get().spawn({
        label: `node-${ns.nodeId}`,
        command: relaunchCmd[0],
        args: relaunchCmd.slice(1),
        cwd: ns.dataDir
      })
    }

    // Start underwriter nodes
    for (const ns of this.state.underwriterNodes ?? []) {
      const relaunchCmd = buildRelaunchCmd(ns.cmd)
      log.info(
        `  Starting underwriter ${ns.nodeId} (port ${ns.port}): ${ns.operatorAccount}`
      )
      await ProcessManager.get().spawn({
        label: `node-${ns.nodeId}`,
        command: relaunchCmd[0],
        args: relaunchCmd.slice(1),
        cwd: ns.dataDir
      })
    }

    // Start anvil (ETH local node)
    if (this.state.anvilStateDir) {
      const anvilManager = await AnvilManager.create({
        stateFile: Path.join(this.state.anvilStateDir, "anvil.json")
      })
      await anvilManager.start()
    }

    // Start solana-test-validator
    if (this.state.solanaLedgerDir) {
      const solManager = await SolanaValidatorManager.create({
        ledgerDir: this.state.solanaLedgerDir
      })
      await solManager.start()
    }

    log.info("All nodes + external chains started")
  }

  /** Stop all running nodes. */
  async stop(): Promise<void> {
    log.info("Stopping cluster...")
    await ProcessManager.get().killAll()
    log.info("Cluster stopped")
  }

  /** Load cluster state from a chain directory's .cluster_state.json. */
  loadState(): void {
    const stateFile = Path.join(this.chainPath, STATE_FILENAME)
    if (!Fs.existsSync(stateFile)) {
      throw new Error(`No cluster state at ${stateFile}`)
    }
    this.state = JSON.parse(Fs.readFileSync(stateFile, "utf-8")) as ClusterState
    log.info(`Loaded cluster state: ${this.state.nodes.length} nodes`)
  }

  // ── Private helpers ──

  /** Launch a nodeop process from a start.cmd args array. */
  private async launchFromCmd(
    label: string,
    cmd: string[],
    cwd: string
  ): Promise<void> {
    await ProcessManager.get().spawn({
      label,
      command: cmd[0],
      args: cmd.slice(1),
      cwd
    })
  }

  /** Persist cluster state to .cluster_state.json. */
  private saveState(chainDir: string, state: ClusterState): void {
    const stateFile = Path.join(chainDir, STATE_FILENAME)
    Fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8")
    log.info(`Cluster state saved to ${stateFile}`)
  }
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
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

  function resolveContractDir(contractName: string): string {
    const buildDir = Path.join(contractsPath, contractName)
    if (Fs.existsSync(Path.join(buildDir, `${contractName}.wasm`)))
      return buildDir
    const libDir = Path.join(libTestingContracts, contractName)
    if (Fs.existsSync(Path.join(libDir, `${contractName}.wasm`))) return libDir
    throw new Error(
      `Contract ${contractName} not found in ${buildDir} or ${libDir}`
    )
  }

  const producerNames: string[] = []
  for (let i = 0; i < cfg.producerCount; i++) {
    producerNames.push(toProducerName(i))
  }

  // ── Phase 1: Wallet already created with all keys imported (before nodeop launch) ──
  log.info("[Phase 1] Wallet ready (keys already imported)")

  // ── Phase 2: Deploy sysio.bios contract ──
  log.info("[Phase 2] Deploying sysio.bios...")
  const biosContractDir = resolveContractDir("sysio.bios")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio",
        biosContractDir,
        "sysio.bios.wasm",
        "sysio.bios.abi"
      ),
    { label: "deploy sysio.bios", maxAttempts: 3, delayMs: 2000 }
  )
  log.info("[Phase 2] sysio.bios deployed")

  // ── Phase 3: Activate ALL protocol features ──
  log.info("[Phase 3] Activating protocol features...")
  const featuresResp = await fetch(
    `${biosHttpUrl}/v1/producer/get_supported_protocol_features`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }
  )
  if (!featuresResp.ok)
    throw new Error(
      `Failed to get protocol features: ${featuresResp.statusText}`
    )
  const rawFeatures = (await featuresResp.json()) as Array<{
    feature_digest: string
    specification?: Array<{ name: string; value: string }>
  }>
  const featureList = Array.isArray(rawFeatures) ? rawFeatures : []
  let activatedCount = 0
  for (const feature of featureList) {
    const digest = feature.feature_digest
    if (!digest) continue
    const codename = feature.specification?.find(
      s => s.name === "builtin_feature_codename"
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
  await sleep(1000)
  log.info("[Phase 3] Activated {} protocol features", activatedCount)

  // ── Phase 4: BLS instant finality setup ──
  log.info("[Phase 4] BLS instant finality setup...")
  try {
    const finalizerNodes: Array<{
      description: string
      weight: number
      public_key: string
      pop: string
    }> = []
    for (const ns of nodeStates) {
      if (!ns.isProducer) continue
      try {
        const nodeUrl = `http://127.0.0.1:${ns.port}`
        const resp = await fetch(`${nodeUrl}/v1/producer/get_finalizer_info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(5000)
        })
        if (resp.ok) {
          const info = (await resp.json()) as {
            finalizer_keys?: Array<{
              public_key: string
              proof_of_possession: string
            }>
          }
          if (info.finalizer_keys?.[0]) {
            finalizerNodes.push({
              description: `finalizer-${ns.nodeId}`,
              weight: 1,
              public_key: info.finalizer_keys[0].public_key,
              pop: info.finalizer_keys[0].proof_of_possession
            })
          }
        }
      } catch {
        /* node may not support this endpoint */
      }
    }
    if (finalizerNodes.length > 0) {
      const threshold = Math.floor((finalizerNodes.length * 2) / 3) + 1
      await clio.pushAction<SystemContracts.SysioBiosSetfinalizerAction>(
        "sysio",
        "setfinalizer",
        { finalizer_policy: { threshold, finalizers: finalizerNodes } },
        "sysio@active"
      )
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
      () =>
        clio.createAccount("sysio", name, DEV_K1_PUBLIC_KEY, DEV_K1_PUBLIC_KEY),
      { label: `create account ${name}`, maxAttempts: 3, delayMs: 1000 }
    )
  }
  log.info(`[Phase 5] Created ${producerNames.length} producer accounts`)

  // ── Phase 6: Create system accounts ──
  log.info("[Phase 6] Creating system accounts...")
  for (const acctName of SYSTEM_ACCOUNTS) {
    try {
      await clio.createSystemAccount(acctName, DEV_K1_PUBLIC_KEY)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("already exists"))
        throw new Error(`Failed to create ${acctName}: ${msg}`)
    }
  }
  log.info(`[Phase 6] Created ${SYSTEM_ACCOUNTS.length} system accounts`)

  // ── Phase 7: Deploy sysio.system ──
  log.info("[Phase 7] Deploying sysio.system...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio",
        resolveContractDir("sysio.system"),
        "sysio.system.wasm",
        "sysio.system.abi"
      ),
    { label: "deploy sysio.system", maxAttempts: 3, delayMs: 2000 }
  )
  log.info("[Phase 7] sysio.system deployed")

  // ── Phase 8: Set producers + handoff ──
  log.info("[Phase 8] Setting producers...")

  // Extract each node's K1 public key from its start.cmd signature-provider arg
  // to use as block_signing_key (matches Python: keys["public"])
  function extractNodeK1PubKey(ns: NodeState): string {
    for (const arg of ns.cmd) {
      const m = arg.match(/^wire-(PUB_K1_\S+),wire,wire,/)
      if (m) return m[1]
      // Also match legacy SYS prefix
      const m2 = arg.match(/^wire-(SYS\S+),wire,wire,/)
      if (m2) return m2[1]
    }
    return DEV_K1_PUBLIC_KEY // fallback
  }

  // Build producer schedule: map each producer name to the signing key of the node that hosts it
  const prodSchedule: Array<{
    producer_name: string
    block_signing_key: string
  }> = []
  for (const name of producerNames.slice(0, 21)) {
    // Find the node that produces this name
    const hostNode =
      nodeStates.find(ns =>
        ns.cmd.some(a => a === name && ns.cmd.includes("--producer-name"))
      ) ??
      nodeStates.find(ns => {
        const prodIdx = ns.cmd.indexOf("--producer-name")
        if (prodIdx === -1) return false
        // Check all --producer-name args
        for (let i = 0; i < ns.cmd.length; i++) {
          if (ns.cmd[i] === "--producer-name" && ns.cmd[i + 1] === name)
            return true
        }
        return false
      })
    const sigKey = hostNode ? extractNodeK1PubKey(hostNode) : DEV_K1_PUBLIC_KEY
    prodSchedule.push({ producer_name: name, block_signing_key: sigKey })
  }

  await clio.pushActionAndWait<SystemContracts.SysioSystemSetprodkeysAction>(
    "sysio",
    "setprodkeys",
    { schedule: prodSchedule },
    "sysio@active"
  )
  log.info("[Phase 8] Waiting for producer handoff (timeout 90s)...")
  const handoffDeadline = Date.now() + ClusterManager.HandoffTimeoutMs
  let handoffComplete = false
  while (Date.now() < handoffDeadline) {
    try {
      const info = await clio.getInfo()
      if (info.head_block_producer && info.head_block_producer !== "sysio") {
        log.info(
          `[Phase 8] Producer handoff: ${info.head_block_producer as string}`
        )
        handoffComplete = true
        break
      }
    } catch {}
    await sleep(1000)
  }
  Assert.ok(handoffComplete, "Producer handoff failed within 90s")

  // ── Phase 9: Deploy sysio.token + setpriv ──
  log.info("[Phase 9] Deploying sysio.token...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio.token",
        resolveContractDir("sysio.token"),
        "sysio.token.wasm",
        "sysio.token.abi"
      ),
    { label: "deploy sysio.token", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.token")
  log.info("[Phase 9] sysio.token deployed")

  // ── Phase 10: Token distribution ──
  log.info("[Phase 10] Creating and distributing tokens...")
  await clio.pushActionAndWait<SystemContracts.SysioTokenCreateAction>(
    "sysio.token",
    "create",
    { issuer: "sysio", maximum_supply: "1000000000.0000 SYS" },
    "sysio.token@active"
  )
  await clio.pushActionAndWait<SystemContracts.SysioTokenIssueAction>(
    "sysio.token",
    "issue",
    { to: "sysio", quantity: "1000000000.0000 SYS", memo: "initial issue" },
    "sysio@active"
  )
  for (const name of producerNames) {
    await clio.pushAction<SystemContracts.SysioTokenTransferAction>(
      "sysio.token",
      "transfer",
      { from: "sysio", to: name, quantity: "1000000.0000 SYS", memo: "init" },
      "sysio@active"
    )
  }
  log.info("[Phase 10] Tokens distributed")

  // ── Phase 11: Deploy sysio.roa ──
  log.info("[Phase 11] Deploying sysio.roa...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio.roa",
        resolveContractDir("sysio.roa"),
        "sysio.roa.wasm",
        "sysio.roa.abi"
      ),
    { label: "deploy sysio.roa", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.roa")
  await clio.pushAction<SystemContracts.SysioRoaActivateroaAction>(
    "sysio.roa",
    "activateroa",
    { total_sys: "75496.0000 SYS", bytes_per_unit: 104 },
    "sysio.roa@active"
  )
  log.info("[Phase 11] sysio.roa deployed")

  // ── Phase 12: Deploy sysio.authex ──
  log.info("[Phase 12] Deploying sysio.authex...")
  await retry(
    () =>
      clio.setContractAndWait(
        "sysio.authex",
        resolveContractDir("sysio.authex"),
        "sysio.authex.wasm",
        "sysio.authex.abi"
      ),
    { label: "deploy sysio.authex", maxAttempts: 3, delayMs: 2000 }
  )
  await clio.setPriv("sysio.authex")
  await clio.pushTransaction({
    account: "sysio",
    name: "updateauth",
    data: {
      account: "sysio.authex",
      permission: "owner",
      parent: "",
      auth: {
        threshold: 1,
        keys: [
          {
            key: DEV_K1_PUBLIC_KEY,
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
        ]
      }
    },
    authorization: [
      {
        actor: "sysio.authex",
        permission: "owner"
      },
      {
        actor: "sysio",
        permission: "active"
      }
    ]
  })
  log.info("[Phase 12] sysio.authex deployed")

  // ── Phase 13: System init ──
  log.info("[Phase 13] System init...")
  await clio.pushAction<SystemContracts.SysioSystemInitAction>(
    "sysio",
    "init",
    { version: 0, core: "4,SYS" },
    "sysio@active"
  )
  log.info("[Phase 13] System initialized")

  // ── Phase 14: Deploy OPP contracts ──
  log.info("[Phase 14] Deploying OPP contracts...")
  for (const [contractName, relPath] of Object.entries(OPP_CONTRACT_PATHS)) {
    const contractDir = Path.join(cfg.buildDir, relPath)
    if (!Fs.existsSync(Path.join(contractDir, `${contractName}.wasm`))) {
      log.warn(`[Phase 14] ${contractName} not found, skipping`)
      continue
    }
    await retry(
      () =>
        clio.setContractAndWait(
          contractName,
          contractDir,
          `${contractName}.wasm`,
          `${contractName}.abi`
        ),
      { label: `deploy ${contractName}`, maxAttempts: 3, delayMs: 2000 }
    )
  }
  log.info("[Phase 14] OPP contracts deployed")

  // ── Phase 15: Configure sysio.epoch ──
  log.info("[Phase 15] Configuring sysio.epoch...")
  // batch_operator_minimum_active must equal operators_per_epoch * batch_op_groups
  // For small clusters, scale down to match
  const batchOpMin = cfg.batchOperatorCount
  const batchOpGroups = Math.min(3, batchOpMin)
  const opsPerEpoch =
    batchOpGroups > 0 ? Math.ceil(batchOpMin / batchOpGroups) : 1
  const adjustedMin = opsPerEpoch * batchOpGroups
  await clio.pushAction<SystemContracts.SysioEpochSetconfigAction>(
    "sysio.epoch",
    "setconfig",
    {
      epoch_duration_sec: 360,
      operators_per_epoch: opsPerEpoch,
      batch_operator_minimum_active: adjustedMin,
      batch_op_groups: batchOpGroups,
      warmup_epochs: 1,
      cooldown_epochs: 1
    },
    "sysio.epoch@active"
  )
  log.info("[Phase 15] sysio.epoch configured")

  // ── Phase 16: Register outposts ──
  log.info("[Phase 16] Registering outposts...")
  await clio.pushAction<SystemContracts.SysioEpochRegoutpostAction>(
    "sysio.epoch",
    "regoutpost",
    { chain_kind: 2, chain_id: 31337 },
    "sysio.epoch@active"
  )
  await clio.pushAction<SystemContracts.SysioEpochRegoutpostAction>(
    "sysio.epoch",
    "regoutpost",
    { chain_kind: 3, chain_id: 0 },
    "sysio.epoch@active"
  )
  log.info("[Phase 16] Outposts registered")

  // ── Phase 17: Configure sysio.uwrit ──
  log.info("[Phase 17] Configuring sysio.uwrit...")
  await clio.pushAction<SystemContracts.SysioUwritSetconfigAction>(
    "sysio.uwrit",
    "setconfig",
    {
      fee_bps: 10,
      confirm_lock_sec: 86400,
      uw_fee_share_pct: 50,
      other_uw_share_pct: 25,
      batch_op_share_pct: 25
    },
    "sysio.uwrit@active"
  )
  log.info("[Phase 17] sysio.uwrit configured")

  // ── Phase 18: Register batch operators ──
  log.info("[Phase 18] Registering batch operators...")
  for (const bo of batchOpStates) {
    const account = bo.operatorAccount!
    try {
      await clio.createAccount(
        "sysio",
        account,
        DEV_K1_PUBLIC_KEY,
        DEV_K1_PUBLIC_KEY
      )
    } catch {}
    await clio.pushAction<SystemContracts.SysioEpochRegoperatorAction>(
      "sysio.epoch",
      "regoperator",
      { account, type: 2 },
      "sysio.epoch@active"
    )
  }
  log.info(`[Phase 18] Registered ${batchOpStates.length} batch operator(s)`)

  // ── Phase 19: Register underwriters ──
  log.info("[Phase 19] Registering underwriters...")
  for (const uw of underwriterStates) {
    const account = uw.operatorAccount!
    try {
      await clio.createAccount(
        "sysio",
        account,
        DEV_K1_PUBLIC_KEY,
        DEV_K1_PUBLIC_KEY
      )
    } catch {}
    await clio.pushAction<SystemContracts.SysioEpochRegoperatorAction>(
      "sysio.epoch",
      "regoperator",
      { account, type: 3 },
      "sysio.epoch@active"
    )
  }
  log.info(`[Phase 19] Registered ${underwriterStates.length} underwriter(s)`)

  log.info("=== Bootstrap sequence complete ===")
}

export namespace ClusterManager {
  // ── Node directory prefixes ──

  /** Directory name for the bios node. */
  export const BiosNodeDir = "node_bios"

  /** Prefix for producer node directories (e.g. node_00, node_01). */
  export const ProducerNodePrefix = "node_"

  /** Prefix for batch operator node directories (e.g. node_batchop_00). */
  export const BatchOpNodePrefix = "node_batchop_"

  /** Prefix for underwriter node directories (e.g. node_uwrit_00). */
  export const UnderwriterNodePrefix = "node_uwrit_"

  /** Zero-pad an index to 2 digits (e.g. 0 → "00", 7 → "07"). */
  export function padIndex(i: number): string {
    return String(i).padStart(2, "0")
  }

  /** Producer node directory name for a given index. */
  export function toProducerNodePath(i: number): string {
    return `${ProducerNodePrefix}${padIndex(i)}`
  }

  /** Batch operator node directory name for a given index. */
  export function toBatchOpNodePath(i: number): string {
    return `${BatchOpNodePrefix}${padIndex(i)}`
  }

  /** Underwriter node directory name for a given index. */
  export function toUnderwriterNodePath(i: number): string {
    return `${UnderwriterNodePrefix}${padIndex(i)}`
  }

  // ── Timeouts & ports ──

  /** kiod wallet daemon port. */
  export const KiodPort = 8900

  /** kiod unlock timeout (seconds). */
  export const KiodUnlockTimeout = 999999

  /** kiod HTTP max response time (ms). */
  export const KiodHttpMaxResponseTimeMs = 99999

  /** Fallback clio URL (used during wallet setup before nodes are up). */
  export const ClioFallbackUrl = "http://127.0.0.1:8788"

  /** Timeout for waiting on kiod startup (ms). */
  export const KiodStartupTimeoutMs = 10_000

  /** Timeout for waiting on a node endpoint (ms). */
  export const NodeStartupTimeoutMs = 30_000

  /** Timeout for producer handoff after setprodkeys (ms). */
  export const HandoffTimeoutMs = 90_000

  /** Delay between staggered node starts (ms). */
  export const NodeStartDelayMs = 2000

  /** Delay after node shutdown before proceeding (ms). */
  export const ShutdownDelayMs = 2000

  // ── Anvil / Solana subdirectories ──

  /** Anvil state subdirectory within chainDir/data. */
  export const AnvilStateSubdir = "anvil/state"

  /** Solana validator ledger subdirectory within chainDir/data. */
  export const SolanaLedgerSubdir = "solana_validator"
}

export default ClusterManager
