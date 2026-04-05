import os from "os"
import Path from "path"
import Fs from "fs"
import { ProcessManager } from "./processes/ProcessManager.js"
import { AnvilManager, type AnvilOptions } from "./processes/AnvilManager.js"
import {
  SolanaValidatorManager,
  type SolanaValidatorOptions
} from "./processes/SolanaValidatorManager.js"
import { type WIREChainConfig } from "./processes/WIREChainManager.js"
import { type ClusterConfig, ClusterManager } from "./cluster/ClusterManager.js"
import { WIREClient } from "./clients/WIREClient.js"
import { ETHClient } from "./clients/ETHClient.js"
import { SOLClient } from "./clients/SOLClient.js"
import { ETHBootstrap } from "./bootstrap/ETHBootstrap.js"
import { SOLBootstrap } from "./bootstrap/SOLBootstrap.js"
import { log } from "./logger.js"
import { mkdirs } from "./util.js"
import { ClusterPorts } from "./cluster/ClusterPorts.js"

export interface TestEnvironmentConfig {
  /** WIRE chain configuration (required) */
  wire: WIREChainConfig & {
    /** Number of producer nodes (default: 1) */
    producerCount?: number
    /** Number of non-producer nodes (default: 0) */
    nodeCount?: number
    /** Number of batch operator nodes (default: 3) */
    batchOperatorCount?: number
    /** Number of underwriter nodes (default: 1) */
    underwriterCount?: number
    /** Epoch duration in seconds (default: 360) */
    epochDurationSec?: number
    /** Warmup epochs (default: 1) */
    warmupEpochs?: number
    /** Cooldown epochs (default: 1) */
    cooldownEpochs?: number
  }
  /** Ethereum/anvil configuration */
  ethereum?: AnvilOptions
  /** Solana validator configuration */
  solana?: SolanaValidatorOptions
  /** Auto-bootstrap WIRE chain after starting (deploy contracts, configure OPP) */
  bootstrapWire?: boolean
  /** Path to wire-ethereum repo for ETH deployment */
  wireEthPath?: string
  /** Path to wire-solana repo for SOL deployment */
  wireSolPath?: string
  /** Temp directory for test artifacts (default: os.tmpdir()) */
  tempPath?: string
}

/**
 * Orchestrates the full multi-chain test environment.
 *
 * Manages child processes for:
 *   - nodeop + kiod (WIRE chain)
 *   - anvil (Ethereum)
 *   - solana-test-validator (Solana)
 *
 * Optionally bootstraps each chain:
 *   - WIRE: bios boot, system contracts, OPP contracts, epoch config
 *   - ETH: deploy outpost stack (OPP, OPPInbound, OperatorRegistry, OutpostReserve, BAR)
 *   - SOL: deploy opp-solana-outpost, initialize PDAs
 *
 * Usage:
 *   const env = new TestEnvironment(config)
 *   await env.start()
 *   // ... run tests using env.wireClient, env.ethClient, env.solClient
 *   await env.stop()
 */
export class TestEnvironment {
  public cluster: ClusterManager
  public anvil: AnvilManager
  public solanaValidator: SolanaValidatorManager

  public wireClient: WIREClient
  public ethClient: ETHClient
  public solClient: SOLClient

  public ethBootstrap: ETHBootstrap
  public solBootstrap: SOLBootstrap

  private readonly tempPath: string

  constructor(readonly config: TestEnvironmentConfig) {
    ProcessManager.setClusterPath(config.wire.clusterPath).get()

    this.tempPath = mkdirs(
      config.tempPath || Path.join(os.tmpdir(), `wire-e2e-${Date.now()}`)
    )
  }

  /** Start all configured chain processes, create clients, and optionally bootstrap. */
  async start(): Promise<void> {
    log.info("Starting test environment in {}", this.tempPath)

    // Register shutdown handler for clean teardown
    const cleanup = () => {
      log.warn("Received signal, stopping test environment...")
      this.stop().then(() => process.exit(0))
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)

    // Determine chain directory
    const clusterPath =
      this.config.wire.clusterPath ?? Path.join(this.tempPath, "wire-chain")

    // Start WIRE chain via ClusterManager (creates genesis, config, bootstraps)
    const {
      producerCount = 1,
      nodeCount = 1,
      batchOperatorCount = 3,
      underwriterCount = 1,
      epochDurationSec = 360,
      warmupEpochs = 1,
      cooldownEpochs = 1
    } = this.config.wire

    const clusterConfig: ClusterConfig = {
      buildPath: this.config.wire.buildPath,
      clusterPath,
      dataPath: Path.join(clusterPath, "data"),
      walletPath: Path.join(clusterPath, "wallet"),
      producerCount,
      nodeCount,
      httpSecure: false,
      batchOperatorCount,
      underwriterCount,
      epochDurationSec,
      warmupEpochs,
      cooldownEpochs,
      ports: await ClusterPorts.resolve({
        nodeCount,
        batchOperatorCount,
        underwriterCount
      }),
      executables: await ClusterManager.resolveExePaths(
        this.config.wire.buildPath
      )
    }

    this.cluster = new ClusterManager(clusterConfig)

    // Remove old chain dir if exists (test isolation)
    if (Fs.existsSync(clusterPath)) {
      Fs.rmSync(clusterPath, { recursive: true, force: true })
    }

    // create() generates genesis, configs, starts bios, runs full bootstrap, saves state
    await this.cluster.create()

    // start() launches all nodes from saved state
    await this.cluster.start()
    // Create WIRE client pointing at first producer node (port 8888)
    const wireHttpUrl = "http://127.0.0.1:8888"
    this.wireClient = new WIREClient({
      httpUrl: wireHttpUrl,
      clio: {
        clusterPath: clusterConfig.clusterPath,
        binary: clusterConfig.executables.clio,
        url: wireHttpUrl
      }
    })

    // Start Ethereum (anvil)
    if (this.config.ethereum !== undefined) {
      this.anvil = await AnvilManager.create(this.config.ethereum)
      await this.anvil.start()
      this.ethClient = new ETHClient(this.anvil.rpcUrl)
    }

    // Start Solana
    if (this.config.solana !== undefined) {
      this.solanaValidator = await SolanaValidatorManager.create(
        this.config.solana
      )
      await this.solanaValidator.start()
      this.solClient = new SOLClient(this.solanaValidator.rpcUrl)
    }

    log.info("Test environment ready")

    // Bootstrap Ethereum outpost
    if (this.config.ethereum && this.config.wireEthPath) {
      this.ethBootstrap = new ETHBootstrap({
        wireEthPath: this.config.wireEthPath,
        rpcUrl: this.anvil!.rpcUrl
      })
      await this.ethBootstrap.bootstrap()
    }

    // Bootstrap Solana outpost
    if (this.config.solana && this.config.wireSolPath) {
      this.solBootstrap = new SOLBootstrap({
        wireSolPath: this.config.wireSolPath,
        rpcUrl: this.solanaValidator!.rpcUrl
      })
      await this.solBootstrap.bootstrap()
    }

    log.info("=== Full environment bootstrapped ===")
  }

  /** Stop all processes in reverse order. */
  async stop(): Promise<void> {
    log.info("Stopping test environment...")
    if (this.solanaValidator) await this.solanaValidator.stop()
    if (this.anvil) await this.anvil.stop()
    if (this.cluster) await this.cluster.stop()
    log.info("Test environment stopped")
  }
}

export default TestEnvironment
