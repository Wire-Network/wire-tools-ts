import OS from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import { ETHBootstrap } from "./bootstrap/ETHBootstrap.js"
import { SOLBootstrap } from "./bootstrap/SOLBootstrap.js"
import { ETHClient } from "./clients/ETHClient.js"
import { SOLClient } from "./clients/SOLClient.js"
import { WIREClient } from "./clients/WIREClient.js"
import { type ClusterConfig, ClusterManager } from "./cluster/ClusterManager.js"
import { ClusterPorts } from "./cluster/ClusterPorts.js"
import { log } from "./logger.js"
import { AnvilManager, type AnvilOptions } from "./processes/AnvilManager.js"
import { ProcessManager } from "./processes/ProcessManager.js"
import { ProcessSignalName } from "./processes/ProcessSignals.js"
import {
  SolanaValidatorManager,
  type SolanaValidatorOptions
} from "./processes/SolanaValidatorManager.js"
import { mkdirs } from "./util.js"

export interface TestEnvironmentConfig {
  /** WIRE chain configuration (required) */
  wire: {
    /** Path to wire-sysio build directory */
    buildPath: string
    /** Chain data directory (created if absent) */
    clusterPath: string
    /** HTTP API port (default: 8888) */
    httpPort?: number
    /** P2P port (default: 9876) */
    p2pPort?: number
    /** Additional nodeop plugins to enable */
    plugins?: string[]
    /** Additional nodeop CLI flags */
    extraArgs?: string[]

    /** Number of producer nodes (default: {@link TestEnvironment.DefaultProducerCount}) */
    producerCount?: number
    /** Number of non-producer nodes (default: {@link TestEnvironment.DefaultNodeCount}) */
    nodeCount?: number
    /** Number of batch operator nodes (default: {@link TestEnvironment.DefaultBatchOperatorCount}) */
    batchOperatorCount?: number
    /** Number of underwriter nodes (default: {@link TestEnvironment.DefaultUnderwriterCount}) */
    underwriterCount?: number
    /** Epoch duration in seconds (default: {@link TestEnvironment.DefaultEpochDurationSec}) */
    epochDurationSec?: number
    /** Warmup epochs (default: {@link TestEnvironment.DefaultWarmupEpochs}) */
    warmupEpochs?: number
    /** Cooldown epochs (default: {@link TestEnvironment.DefaultCooldownEpochs}) */
    cooldownEpochs?: number
  }
  /** Ethereum/anvil configuration */
  ethereum?: AnvilOptions
  /** Solana validator configuration */
  solana?: SolanaValidatorOptions
  /** Auto-bootstrap WIRE chain after starting (deploy contracts, configure OPP) */
  bootstrapWire?: boolean
  /** Path to wire-ethereum repo for ETH deployment */
  ethereumPath?: string
  /** Path to wire-solana repo for SOL deployment */
  solanaPath?: string
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
  /** Live WIRE cluster orchestrator (nodeop + kiod lifecycle). */
  public cluster: ClusterManager
  /** Local Ethereum devnet (anvil) manager. */
  public anvil: AnvilManager
  /** Local Solana test validator manager. */
  public solanaValidator: SolanaValidatorManager

  /** HTTP/RPC client for the bootstrapped WIRE chain. */
  public wireClient: WIREClient
  /** ethers.js-backed client targeting {@link anvil}. */
  public ethClient: ETHClient
  /** @solana/web3.js client targeting {@link solanaValidator}. */
  public solClient: SOLClient

  /** Deploys the OPP outpost contract stack onto Ethereum. */
  public ethBootstrap: ETHBootstrap
  /** Initializes the OPP outpost program / PDAs on Solana. */
  public solBootstrap: SOLBootstrap

  /** Scratch directory used for per-run keypairs, logs, and cluster data. */
  private readonly tempPath: string

  /**
   * Construct a {@link TestEnvironment}. Does NOT start any processes —
   * call {@link start} to launch the cluster, chains, and bootstrap steps.
   *
   * @param config - Fully-resolved environment configuration. The wire
   *                 cluster path is bound to the singleton
   *                 {@link ProcessManager} immediately, so callers must not
   *                 construct two environments against different paths in
   *                 the same process.
   */
  constructor(readonly config: TestEnvironmentConfig) {
    ProcessManager.setClusterPath(config.wire.clusterPath).get()

    this.tempPath = mkdirs(
      config.tempPath ||
        Path.join(
          OS.tmpdir(),
          `${TestEnvironment.TempPathPrefix}${Date.now()}`
        )
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
    process.on(ProcessSignalName.SIGINT, cleanup)
    process.on(ProcessSignalName.SIGTERM, cleanup)

    // Resolve cluster directory — fall back to a per-run temp subpath when the
    // caller didn't provide one.
    const clusterPath =
      this.config.wire.clusterPath ??
      Path.join(this.tempPath, TestEnvironment.DefaultChainSubdir)

    // Pull caller-provided counts; fill in defaults from the namespace.
    const {
      producerCount = TestEnvironment.DefaultProducerCount,
      nodeCount = TestEnvironment.DefaultNodeCount,
      batchOperatorCount = TestEnvironment.DefaultBatchOperatorCount,
      underwriterCount = TestEnvironment.DefaultUnderwriterCount,
      epochDurationSec = TestEnvironment.DefaultEpochDurationSec,
      warmupEpochs = TestEnvironment.DefaultWarmupEpochs,
      cooldownEpochs = TestEnvironment.DefaultCooldownEpochs
    } = this.config.wire

    const clusterConfig: ClusterConfig = {
      buildPath: this.config.wire.buildPath,
      clusterPath,
      dataPath: Path.join(clusterPath, ClusterManager.DataSubpath),
      walletPath: Path.join(clusterPath, ClusterManager.WalletSubpath),
      ethereumPath: this.config.ethereumPath,
      solanaPath: this.config.solanaPath,
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

    // WIRE client points at the first producer node, using the resolved port.
    const wireHttpUrl = TestEnvironment.toLocalHttpUrl(
      clusterConfig.ports.producerHttp[0]
    )
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
    if (this.config.ethereum && this.config.ethereumPath) {
      this.ethBootstrap = new ETHBootstrap({
        wireEthPath: this.config.ethereumPath,
        rpcUrl: this.anvil!.rpcUrl
      })
      await this.ethBootstrap.bootstrap()
    }

    // Bootstrap Solana outpost
    if (this.config.solana && this.config.solanaPath) {
      this.solBootstrap = new SOLBootstrap({
        wireSolPath: this.config.solanaPath,
        rpcUrl: this.solanaValidator!.rpcUrl
      })
      await this.solBootstrap.bootstrap()
    }

    log.info(TestEnvironment.BootstrapDoneBanner)
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

export namespace TestEnvironment {
  /** Loopback host used when constructing local RPC URLs. */
  export const LocalHost = "127.0.0.1" as const
  /** Prefix used when synthesising a per-run temp directory under `os.tmpdir()`. */
  export const TempPathPrefix = "wire-e2e-" as const
  /** Subdirectory under the temp path used as the cluster root when none is supplied. */
  export const DefaultChainSubdir = "wire-chain" as const

  /** Banner logged once the full multi-chain bootstrap finishes. */
  export const BootstrapDoneBanner = "=== Full environment bootstrapped ===" as const

  // ── Cluster-shape defaults ────────────────────────────────────────────────
  /** Default number of WIRE producer nodes when none is specified. */
  export const DefaultProducerCount = 1
  /** Default number of WIRE non-producer nodes when none is specified. */
  export const DefaultNodeCount = 1
  /** Default number of batch-operator nodes when none is specified. */
  export const DefaultBatchOperatorCount = 3
  /** Default number of underwriter nodes when none is specified. */
  export const DefaultUnderwriterCount = 1
  /** Default epoch duration (seconds). */
  export const DefaultEpochDurationSec = 360
  /** Default WARMUP→ACTIVE delay (epochs). */
  export const DefaultWarmupEpochs = 1
  /** Default COOLDOWN→deregister delay (epochs). */
  export const DefaultCooldownEpochs = 1

  /** Build a `http://127.0.0.1:<port>` URL using the loopback host constant. */
  export function toLocalHttpUrl(port: number): string {
    return `http://${LocalHost}:${port}`
  }
}
