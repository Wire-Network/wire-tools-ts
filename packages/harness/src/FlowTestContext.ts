import Assert from "node:assert"
import Path from "node:path"
import Fs from "node:fs"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { log } from "./logger.js"
import { sleep } from "./util.js"
import { ClusterManager, type ClusterConfig } from "./cluster/ClusterManager.js"
import { type ClusterPorts } from "./cluster/ClusterPorts.js"
import { WIREClient } from "./clients/WIREClient.js"
import { ProcessManager } from "./processes/ProcessManager.js"
import { asOption } from "@3fv/prelude-ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anvil's default account #0 private key (deterministic). */
export const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a flow test obtains the cluster it talks to.
 *
 * - `Fresh`  — create a new cluster for this test run and tear it down after.
 * - `Attach` — connect to a long-running cluster whose `cluster-config.json`
 *              is already on disk. Flow tests invoked via
 *              `wire-test-cluster run` typically use this.
 */
export enum FlowMode {
  Fresh = "fresh",
  Attach = "attach"
}

/**
 * Caller-supplied config for {@link FlowTestContext}. Field requirements
 * depend on the {@link FlowMode} resolved at construction time.
 */
export interface FlowTestContextOptions {
  /**
   * Path to the `cluster-config.json` written by `wire-test-cluster create`.
   * Required (implicitly or via `WIRE_CLUSTER_CONFIG`) when running in
   * `Attach` mode; ignored in `Fresh` mode.
   */
  clusterConfigPath?: string

  /** Path to the wire-sysio build directory. Required in `Fresh` mode. */
  buildPath?: string
  /** Where to materialize the cluster. Required in `Fresh` mode. */
  clusterPath?: string
  /** Path to wire-ethereum repo root (enables Anvil + ETH outpost). */
  ethereumPath?: string
  /** Number of producers to bake into genesis. Default: 21. */
  producerCount?: number
  /** Total nodeop nodes. Default: `producerCount`. */
  nodeCount?: number
  /** Batch operator nodes to create. Default: 3. */
  batchOperatorCount?: number
  /** Underwriter nodes to create. Default: 1. */
  underwriterCount?: number
  /** Epoch duration in seconds. Default: 360. */
  epochDurationSec?: number
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Poll a condition until it returns true or timeout expires.
 */
export async function pollUntil(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for: ${label} (${timeoutMs}ms)`)
}

// ---------------------------------------------------------------------------
// FlowTestContext
// ---------------------------------------------------------------------------

export class FlowTestContext {
  private constructor(
    readonly mode: FlowMode,
    readonly manager: ClusterManager,
    readonly wireClient: WIREClient,
    readonly ethProvider: ethers.JsonRpcProvider,
    readonly ethSigner: ethers.Wallet,
    readonly ports: ClusterPorts,
    private readonly config: ClusterConfig
  ) {}

  /** Resolved ethereum repo path (from config or env). */
  get ethereumPath(): string | undefined {
    return this.config.ethereumPath ?? process.env.WIRE_ETH_PATH
  }

  /** Cluster data path. */
  get clusterPath(): string {
    return this.config.clusterPath
  }

  // ── Factory ─────────────────────────────────────────────────────────────

  /** Create a FlowTestContext — attach to running cluster or create fresh. */
  static async create(
    opts: FlowTestContextOptions = {}
  ): Promise<FlowTestContext> {
    return asOption(opts.clusterConfigPath ?? process.env.WIRE_CLUSTER_CONFIG)
      .filter(Fs.existsSync)
      .match({
        Some: configPath => FlowTestContext.attach(configPath),
        None: () => FlowTestContext.fresh(opts)
      })
  }

  /** Connect to an already-running cluster from its cluster-config.json. */
  static async attach(configPath: string): Promise<FlowTestContext> {
    Assert.ok(
      Fs.existsSync(configPath),
      `Cluster config not found: ${configPath}`
    )
    log.info(
      "[FlowTestContext] Attaching to running cluster from %s",
      configPath
    )

    const config: ClusterConfig = JSON.parse(
      Fs.readFileSync(configPath, "utf-8")
    )

    ProcessManager.setClusterPath(config.clusterPath)
    const manager = new ClusterManager(config)
    manager.loadState()

    return FlowTestContext.createClients(FlowMode.Attach, manager, config)
  }

  /** Create a fresh cluster from scratch — full create + bootstrap + start. */
  static async fresh(opts: FlowTestContextOptions): Promise<FlowTestContext> {
    const buildPath = opts.buildPath ?? process.env.WIRE_BUILD_PATH,
      clusterPath = opts.clusterPath ?? process.env.WIRE_CLUSTER_PATH,
      ethereumPath = opts.ethereumPath ?? process.env.WIRE_ETH_PATH

    Assert.ok(buildPath, "WIRE_BUILD_PATH required for fresh mode")
    Assert.ok(clusterPath, "WIRE_CLUSTER_PATH required for fresh mode")

    log.info("[FlowTestContext] Creating fresh cluster at %s", clusterPath)

    const manager = await ClusterManager.createFromCLIArgs({
      buildPath,
      clusterPath,
      ethereumPath,
      producerCount: opts.producerCount ?? 21,
      nodeCount: opts.nodeCount ?? 1,
      batchOperatorCount: opts.batchOperatorCount ?? 3,
      underwriterCount: opts.underwriterCount ?? 1,
      epochDurationSec: opts.epochDurationSec ?? 90,
      force: true
    })

    manager.loadState()
    await manager.start()

    return FlowTestContext.createClients(
      FlowMode.Fresh,
      manager,
      manager.config
    )
  }

  /** Shared client creation for both modes. */
  private static createClients(
    mode: FlowMode,
    manager: ClusterManager,
    config: ClusterConfig
  ): FlowTestContext {
    const ports = config.ports

    const wireClient = new WIREClient({
      httpUrl: `http://127.0.0.1:${ports.producerHttp[0]}`,
      clio: {
        clusterPath: config.clusterPath,
        binary: config.executables.clio,
        url: `http://127.0.0.1:${ports.producerHttp[0]}`,
        walletUrl: `http://127.0.0.1:${ports.kiod}`
      }
    })

    const ethProvider = new ethers.JsonRpcProvider(
      `http://127.0.0.1:${ports.anvil}`
    )
    const ethSigner = new ethers.Wallet(ANVIL_DEFAULT_PRIVATE_KEY, ethProvider)

    return new FlowTestContext(
      mode,
      manager,
      wireClient,
      ethProvider,
      ethSigner,
      ports,
      config
    )
  }

  // ── ETH helpers ─────────────────────────────────────────────────────────

  /** Load ETH contract addresses from wire-ethereum deployments. */
  loadETHAddresses(): Record<string, string> {
    Assert.ok(this.ethereumPath, "ethereumPath required for ETH addresses")
    const addrsPath = Path.join(
      this.ethereumPath,
      ".local/deployments/outpost-addrs.json"
    )
    Assert.ok(Fs.existsSync(addrsPath), `ETH addresses not found: ${addrsPath}`)
    return JSON.parse(Fs.readFileSync(addrsPath, "utf-8"))
  }

  /** Load ETH ABI for a contract name. */
  loadETHABI(contractName: string): ethers.InterfaceAbi {
    Assert.ok(this.ethereumPath, "ethereumPath required for ETH ABIs")
    const artifactPath = Path.join(
      this.ethereumPath,
      "artifacts/contracts/outpost",
      `${contractName}.sol`,
      `${contractName}.json`
    )
    return JSON.parse(Fs.readFileSync(artifactPath, "utf-8")).abi
  }

  /** Load an ETH contract instance by name and address. */
  loadETHContract(name: string, address: string): ethers.Contract {
    return new ethers.Contract(address, this.loadETHABI(name), this.ethSigner)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Teardown: stops cluster in fresh mode, no-op in attach mode. */
  async teardown(): Promise<void> {
    await match(this.mode)
      .with(FlowMode.Fresh, async () => {
        log.info("[FlowTestContext] Stopping fresh cluster…")
        await this.manager.stop()
      })
      .with(FlowMode.Attach, () => {
        log.info("[FlowTestContext] Attach mode — skipping teardown")
      })
      .exhaustive()
  }
}
