import os from "os"
import Path from "path"
import Fs from "fs"
import { ProcessManager } from "./processes/ProcessManager.js"
import { AnvilManager, type AnvilOptions } from "./processes/AnvilManager.js"
import {
  SolanaValidatorManager,
  type SolanaValidatorOptions
} from "./processes/SolanaValidatorManager.js"
import { type WIREChainConfig } from "./processes/WIREChainManager"
import { type ClusterConfig, ClusterManager } from "./cluster/ClusterManager.js"
import { WIREClient } from "./clients/WIREClient"
import { ETHClient } from "./clients/ETHClient.js"
import { SOLClient } from "./clients/SOLClient.js"
import { ETHBootstrap } from "./bootstrap/ETHBootstrap.js"
import { SOLBootstrap } from "./bootstrap/SOLBootstrap.js"
import { log } from "./logger.js"
import { mkdirs } from "./util"

export interface TestEnvironmentConfig {
  /** WIRE chain configuration (required) */
  wire: WIREChainConfig & {
    /** Path to wire-sysio source dir (for pre-built contract artifacts) */
    sourceDir?: string
    /** Number of producer nodes (default: 1) */
    producerCount?: number
    /** Number of batch operator nodes (default: 1) */
    batchOperatorCount?: number
    /** Number of underwriter nodes (default: 1) */
    underwriterCount?: number
  }
  /** Ethereum/anvil configuration */
  ethereum?: AnvilOptions
  /** Solana validator configuration */
  solana?: SolanaValidatorOptions
  /** Auto-bootstrap WIRE chain after starting (deploy contracts, configure OPP) */
  bootstrapWire?: boolean
  /** Path to wire-ethereum repo for ETH deployment */
  wireEthDir?: string
  /** Path to wire-solana repo for SOL deployment */
  wireSolDir?: string
  /** Temp directory for test artifacts (default: os.tmpdir()) */
  tempDir?: string
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
  public cluster?: ClusterManager
  public anvil?: AnvilManager
  public solanaValidator?: SolanaValidatorManager

  public wireClient?: WIREClient
  public ethClient?: ETHClient
  public solClient?: SOLClient

  public ethBootstrap?: ETHBootstrap
  public solBootstrap?: SOLBootstrap

  private readonly tempDir: string

  constructor(readonly config: TestEnvironmentConfig) {
    ProcessManager.setClusterPath(config.wire.chainDir).get()

    this.tempDir = mkdirs(
      config.tempDir || Path.join(os.tmpdir(), `wire-e2e-${Date.now()}`)
    )
  }

  /** Start all configured chain processes, create clients, and optionally bootstrap. */
  async start(): Promise<void> {
    log.info("Starting test environment in {}", this.tempDir)

    // Register shutdown handler for clean teardown
    const cleanup = () => {
      log.warn("Received signal, stopping test environment...")
      this.stop().then(() => process.exit(0))
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)

    // Determine chain directory
    const chainDir =
      this.config.wire.chainDir || Path.join(this.tempDir, "wire-chain")

    // Infer source dir from build dir (go up from build/<variant> to repo root)
    const sourceDir =
      this.config.wire.sourceDir ||
      Path.resolve(this.config.wire.buildDir, "..", "..")

    // Start WIRE chain via ClusterManager (creates genesis, config, bootstraps)
    const clusterConfig: ClusterConfig = {
      buildDir: this.config.wire.buildDir,
      chainDir,
      sourceDir,
      producerCount: this.config.wire.producerCount ?? 1,
      nodeCount: 1,
      httpSecure: false,
      batchOperatorCount: this.config.wire.batchOperatorCount ?? 1,
      underwriterCount: this.config.wire.underwriterCount ?? 1
    }

    this.cluster = new ClusterManager(clusterConfig)

    // Remove old chain dir if exists (test isolation)
    if (Fs.existsSync(chainDir)) {
      Fs.rmSync(chainDir, { recursive: true, force: true })
    }

    // create() generates genesis, configs, starts bios, runs full bootstrap, saves state
    await this.cluster.create()

    // start() launches all nodes from saved state
    await this.cluster.start()
    // Create WIRE client pointing at first producer node (port 8888)
    const wireHttpUrl = "http://127.0.0.1:8888",
      clioBinary = Path.join(this.config.wire.buildDir, "bin", "clio")
    this.wireClient = new WIREClient({
      httpUrl: wireHttpUrl,
      clio: {
        binary: clioBinary,
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
    if (this.config.ethereum && this.config.wireEthDir) {
      this.ethBootstrap = new ETHBootstrap({
        wireEthDir: this.config.wireEthDir,
        rpcUrl: this.anvil!.rpcUrl
      })
      await this.ethBootstrap.bootstrap()
    }

    // Bootstrap Solana outpost
    if (this.config.solana && this.config.wireSolDir) {
      this.solBootstrap = new SOLBootstrap({
        wireSolDir: this.config.wireSolDir,
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
