import Assert from "node:assert"
import Path from "node:path"
import Fs from "node:fs"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { asOption } from "@3fv/prelude-ts"
import { type ClusterConfig, ClusterManager } from "./cluster/ClusterManager.js"
import { type ClusterPorts } from "./cluster/ClusterPorts.js"
import { WIREClient } from "./clients/WIREClient.js"
import { ClusterOptions } from "./HarnessTypes.js"
import { log } from "./logger.js"
import { ProcessManager } from "./processes/ProcessManager.js"
import { sleep } from "./util.js"

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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Poll a condition until it returns true or the deadline expires.
 *
 * @param label Description used in the timeout error message.
 * @param condition Async predicate; resolved truthy stops polling.
 * @param timeoutMs Total time budget before throwing.
 * @param intervalMs Sleep between probes (default {@link FlowTestContext.DefaultPollIntervalMs}).
 */
export async function pollUntil(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = FlowTestContext.DefaultPollIntervalMs
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
    return (
      this.config.ethereumPath ??
      process.env[FlowTestContext.EnvVar.EthereumPath]
    )
  }

  /** Cluster data path. */
  get clusterPath(): string {
    return this.config.clusterPath
  }

  // ── Factory ─────────────────────────────────────────────────────────────

  /**
   * Create a FlowTestContext — attach to a running cluster (when a config path
   * is provided or `WIRE_CLUSTER_CONFIG` is set and points at a real file) or
   * create a fresh one.
   */
  static async create(opts: ClusterOptions = {}): Promise<FlowTestContext> {
    return asOption(
      opts.clusterConfigPath ??
        process.env[FlowTestContext.EnvVar.ClusterConfig]
    )
      .filter(Fs.existsSync)
      .match({
        Some: configPath => FlowTestContext.attach(configPath),
        None: () => FlowTestContext.fresh(opts)
      })
  }

  /** Connect to an already-running cluster from its `cluster-config.json`. */
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
  static async fresh(opts: ClusterOptions): Promise<FlowTestContext> {
    const buildPath =
        opts.buildPath ?? process.env[FlowTestContext.EnvVar.BuildPath],
      clusterPath =
        opts.clusterPath ?? process.env[FlowTestContext.EnvVar.ClusterPath],
      ethereumPath =
        opts.ethereumPath ?? process.env[FlowTestContext.EnvVar.EthereumPath],
      solanaPath =
        opts.solanaPath ?? process.env[FlowTestContext.EnvVar.SolanaPath]

    Assert.ok(
      buildPath,
      `${FlowTestContext.EnvVar.BuildPath} required for fresh mode`
    )
    Assert.ok(
      clusterPath,
      `${FlowTestContext.EnvVar.ClusterPath} required for fresh mode`
    )
    Assert.ok(
      ethereumPath,
      `${FlowTestContext.EnvVar.EthereumPath} required for fresh mode`
    )
    Assert.ok(
      solanaPath,
      `${FlowTestContext.EnvVar.SolanaPath} required for fresh mode`
    )
    log.info("[FlowTestContext] Creating fresh cluster at %s", clusterPath)

    const manager = await ClusterManager.createFromCLIArgs({
      buildPath,
      clusterPath,
      ethereumPath,
      solanaPath,
      producerCount:
        opts.producerCount ?? FlowTestContext.DefaultProducerCount,
      nodeCount: opts.nodeCount ?? FlowTestContext.DefaultNodeCount,
      batchOperatorCount:
        opts.batchOperatorCount ??
        FlowTestContext.DefaultBatchOperatorCount,
      underwriterCount:
        opts.underwriterCount ?? FlowTestContext.DefaultUnderwriterCount,
      epochDurationSec:
        opts.epochDurationSec ?? FlowTestContext.DefaultEpochDurationSec,
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
    const ports = config.ports,
      producerUrl = FlowTestContext.toLocalHttpUrl(ports.producerHttp[0]),
      kiodUrl = FlowTestContext.toLocalHttpUrl(ports.kiod),
      anvilUrl = FlowTestContext.toLocalHttpUrl(ports.anvil)

    const wireClient = new WIREClient({
      httpUrl: producerUrl,
      clio: {
        clusterPath: config.clusterPath,
        binary: config.executables.clio,
        url: producerUrl,
        walletUrl: kiodUrl
      }
    })

    const ethProvider = new ethers.JsonRpcProvider(anvilUrl)
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
      FlowTestContext.EthAddressesRelPath
    )
    Assert.ok(Fs.existsSync(addrsPath), `ETH addresses not found: ${addrsPath}`)
    return JSON.parse(Fs.readFileSync(addrsPath, "utf-8"))
  }

  /** Load ETH ABI for a contract name. */
  loadETHABI(contractName: string): ethers.InterfaceAbi {
    Assert.ok(this.ethereumPath, "ethereumPath required for ETH ABIs")
    const artifactPath = Path.join(
      this.ethereumPath,
      FlowTestContext.EthArtifactsRelPath,
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

export namespace FlowTestContext {
  /** Loopback host used when constructing local RPC URLs. */
  export const LocalHost = "127.0.0.1" as const
  /** Default poll interval for {@link pollUntil}. */
  export const DefaultPollIntervalMs = 2_000

  // ── `fresh` mode defaults ─────────────────────────────────────────────────
  /** Default registered-producer count (matches harness CLI default). */
  export const DefaultProducerCount = 21
  /** Default non-producer node count. */
  export const DefaultNodeCount = 1
  /** Default batch-operator count. */
  export const DefaultBatchOperatorCount = 3
  /** Default underwriter count. */
  export const DefaultUnderwriterCount = 1
  /** Default epoch duration (seconds) for fresh-mode clusters. */
  export const DefaultEpochDurationSec = 90

  // ── External wire-ethereum layout ────────────────────────────────────────
  /** Subpath beneath the wire-ethereum repo where deployment addresses live. */
  export const EthAddressesRelPath =
    ".local/deployments/outpost-addrs.json" as const
  /** Subpath beneath the wire-ethereum repo where Hardhat artifacts live. */
  export const EthArtifactsRelPath = "artifacts/contracts/outpost" as const

  /** Environment-variable names checked by `attach`/`fresh`. */
  export enum EnvVar {
    BuildPath = "WIRE_BUILD_PATH",
    ClusterPath = "WIRE_CLUSTER_PATH",
    EthereumPath = "WIRE_ETH_PATH",
    SolanaPath = "WIRE_SOLANA_PATH",
    ClusterConfig = "WIRE_CLUSTER_CONFIG"
  }

  /** Build a `http://127.0.0.1:<port>` URL using the loopback host constant. */
  export function toLocalHttpUrl(port: number): string {
    return `http://${LocalHost}:${port}`
  }
}
