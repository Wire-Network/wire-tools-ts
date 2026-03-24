import os from "os"
import path from "path"
import fs from "fs"
import { ProcessManager } from "./processes/process-manager.js"
import { AnvilManager, type AnvilConfig } from "./processes/anvil.js"
import { SolanaValidatorManager, type SolanaValidatorConfig } from "./processes/solana-validator.js"
import { WireChainManager, type WireChainConfig } from "./processes/wire-chain.js"
import { WireClient } from "./clients/wire-client.js"
import { EthClient } from "./clients/eth-client.js"
import { SolClient } from "./clients/sol-client.js"
import { WireBootstrap, type WireBootstrapConfig } from "./bootstrap/wire-bootstrap.js"
import { EthBootstrap, type EthBootstrapConfig } from "./bootstrap/eth-bootstrap.js"
import { SolBootstrap, type SolBootstrapConfig } from "./bootstrap/sol-bootstrap.js"
import { log } from "./logger.js"

export interface TestEnvironmentConfig {
  /** WIRE chain configuration (required) */
  wire: WireChainConfig
  /** Ethereum/anvil configuration */
  ethereum?: AnvilConfig
  /** Solana validator configuration */
  solana?: SolanaValidatorConfig
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
  public pm: ProcessManager
  public wireChain?: WireChainManager
  public anvil?: AnvilManager
  public solanaValidator?: SolanaValidatorManager

  public wireClient?: WireClient
  public ethClient?: EthClient
  public solClient?: SolClient

  public wireBootstrap?: WireBootstrap
  public ethBootstrap?: EthBootstrap
  public solBootstrap?: SolBootstrap

  private config: TestEnvironmentConfig
  private tempDir: string

  constructor(config: TestEnvironmentConfig) {
    this.config = config
    this.pm = new ProcessManager()
    this.tempDir = config.tempDir || path.join(os.tmpdir(), `wire-e2e-${Date.now()}`)
    fs.mkdirSync(this.tempDir, { recursive: true })
  }

  /** Start all configured chain processes, create clients, and optionally bootstrap. */
  async start(): Promise<void> {
    log.info("Starting test environment in %s", this.tempDir)

    // Register shutdown handler for clean teardown
    const cleanup = () => {
      log.warn("Received signal, stopping test environment...")
      this.stop().then(() => process.exit(0))
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)

    // Start WIRE chain
    this.wireChain = new WireChainManager(this.pm, this.config.wire)
    await this.wireChain.start()
    this.wireClient = new WireClient({
      httpUrl: this.wireChain.httpUrl,
      clio: {
        binary: this.wireChain.clio,
        url: this.wireChain.httpUrl,
      },
    })

    // Start Ethereum (anvil)
    if (this.config.ethereum !== undefined) {
      this.anvil = new AnvilManager(this.pm, this.config.ethereum)
      await this.anvil.start()
      this.ethClient = new EthClient(this.anvil.rpcUrl)
    }

    // Start Solana
    if (this.config.solana !== undefined) {
      this.solanaValidator = new SolanaValidatorManager(this.pm, this.config.solana)
      await this.solanaValidator.start()
      this.solClient = new SolClient(this.solanaValidator.rpcUrl)
    }

    log.info("Test environment ready (%d processes)", this.pm.count)

    // Bootstrap WIRE chain
    if (this.config.bootstrapWire !== false) {
      this.wireBootstrap = new WireBootstrap({
        buildDir: this.config.wire.buildDir,
        httpUrl: this.wireChain.httpUrl,
        clioBinary: this.wireChain.clio,
      })
      await this.wireBootstrap.bootstrap()
    }

    // Bootstrap Ethereum outpost
    if (this.config.ethereum && this.config.wireEthDir) {
      this.ethBootstrap = new EthBootstrap({
        wireEthDir: this.config.wireEthDir,
        rpcUrl: this.anvil!.rpcUrl,
      })
      await this.ethBootstrap.bootstrap()
    }

    // Bootstrap Solana outpost
    if (this.config.solana && this.config.wireSolDir) {
      this.solBootstrap = new SolBootstrap({
        wireSolDir: this.config.wireSolDir,
        rpcUrl: this.solanaValidator!.rpcUrl,
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
    if (this.wireChain) await this.wireChain.stop()
    log.info("Test environment stopped")
  }
}
