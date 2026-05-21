import Assert from "node:assert"
import Path from "node:path"
import Fs from "node:fs"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { asOption } from "@3fv/prelude-ts"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import { type ClusterConfig, ClusterManager } from "./cluster/ClusterManager.js"
import { readClusterConfigFile } from "./cluster/ClusterConfigPersistence.js"
import { toURL } from "./tools/NetTools.js"
import { type ClusterPorts } from "./cluster/ClusterPorts.js"
import { WIREClient } from "./clients/WIREClient.js"
import { ClusterOptions } from "./HarnessTypes.js"
import { log } from "./logger.js"
import { ProcessManager } from "./processes/ProcessManager.js"
import { sleep } from "./util.js"
import {
  type OperatorAccountWallet,
  buildEthereumOperatorWallets,
  buildSolanaOperatorWallets,
  buildWireOperatorWallets
} from "./wallet/index.js"

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
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await condition()) return
    } catch (err) {
      // Transient RPC failures (anvil ECONNREFUSED, momentary clio HTTP 500,
      // solana RPC timeout) must NOT end the test. The cluster's RPC
      // surfaces are hammered by 3 batch ops + 1 underwriter polling every
      // few seconds; one in N polls can hit a fleeting socket / keepalive
      // hiccup. The `pollUntil` deadline is the timing budget — let it run.
      // Log the most recent transient so a real RPC-down state is visible
      // on the timeout error message.
      lastError = err
      log.debug(`pollUntil[${label}]: transient — ${err instanceof Error ? err.message : String(err)}`)
    }
    await sleep(intervalMs)
  }
  const tail = lastError
    ? ` (last transient: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    : ""
  throw new Error(`Timed out waiting for: ${label} (${timeoutMs}ms)${tail}`)
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

  /** Resolved solana repo path (from config or env). Used by tests that
   *  need to load the deployed program's IDL or program-id keypair. */
  get solanaPath(): string | undefined {
    return (
      this.config.solanaPath ??
      process.env[FlowTestContext.EnvVar.SolanaPath]
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

    const config: ClusterConfig = readClusterConfigFile(configPath)

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
      terminateMaxConsecutiveMisses: opts.terminateMaxConsecutiveMisses,
      terminateMaxPctMisses24H: opts.terminateMaxPctMisses24H,
      terminateWindowMs: opts.terminateWindowMs,
      reqProdCollat:    opts.reqProdCollat,
      reqBatchopCollat: opts.reqBatchopCollat,
      reqUwCollat:      opts.reqUwCollat,
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
      producerUrl = toURL(ports.producerHttp[0]),
      kiodUrl = toURL(ports.kiod),
      anvilUrl = toURL(ports.anvil)

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

  // ── Operator wallet accessors ───────────────────────────────────────────

  /**
   * Lazy cache for {@link getWallet}. Computing the per-chain wallet
   * bundle requires HD-derivation (ETH) or base58 decoding (SOL) for
   * every bootstrapped operator; we do it once per `(chain, type)` pair
   * and hand out a stable array.
   *
   * Key shape: `"<chain>:<type>"` — both ChainKind and OperatorType are
   * numeric enums, so a small string composite avoids nested maps.
   */
  private walletCacheByChainAndType = new Map<string, OperatorAccountWallet[]>()

  /**
   * Return the bootstrapped operator wallets for a `(chain, type)` pair.
   *
   * `ClusterManager` Phases 18a / 19 / 19a have already created the WIRE
   * account, registered the operator in `sysio.opreg::operators`, and
   * written `sysio.authex::links` entries binding it to chain-specific
   * pubkeys. The returned wallets can sign on the originating chain
   * (`ethers.HDNodeWallet` for ETH, `@solana/web3.js Keypair` for SOL,
   * clio-mediated for WIRE) and carry the curve-appropriate
   * `PublicKey` / `PrivateKey` that downstream OPP attestations index on.
   *
   * Each entry in the returned array is a concrete subclass keyed on
   * `chain` (e.g., `EthereumOperatorAccountWallet` for
   * `ChainKind.EVM`); call sites can narrow via `instanceof` if
   * they need chain-specific surface beyond the interface.
   *
   * @param chain  Originating chain — `ETHEREUM`, `SOLANA`, or `WIRE`.
   * @param type   Operator type — `BATCH`, `UNDERWRITER`. (`PRODUCER` is
   *               not bootstrapped through opreg; callers asking for it
   *               raise.)
   * @return Read-only array of {@link OperatorAccountWallet}s — empty if
   *         the cluster is configured with zero operators of that type.
   */
  getWallet(
    chain: ChainKind,
    type: OperatorType
  ): readonly OperatorAccountWallet[] {
    const key = `${chain}:${type}`
    const cached = this.walletCacheByChainAndType.get(key)
    if (cached !== undefined) return cached
    const built = this.computeWallets(chain, type)
    this.walletCacheByChainAndType.set(key, built)
    return built
  }

  /**
   * One-shot computation for {@link getWallet}'s cache. Reads the
   * persisted cluster state, selects the operators of the requested
   * `type`, and hands each off to the chain-specific factory under
   * `src/wallet/`.
   */
  private computeWallets(
    chain: ChainKind,
    type: OperatorType
  ): OperatorAccountWallet[] {
    const state = this.manager.state
    Assert.ok(
      state,
      "FlowTestContext.getWallet: cluster state not loaded — call after manager.loadState()"
    )
    const batchOps = state.batchOperatorNodes ?? [],
      underwriters = state.underwriterNodes ?? []
    return match(chain)
      .with(ChainKind.EVM, () =>
        buildEthereumOperatorWallets({
          ethProvider: this.ethProvider,
          batchOps,
          underwriters,
          type
        })
      )
      .with(ChainKind.SVM, () =>
        buildSolanaOperatorWallets({ batchOps, underwriters, type })
      )
      .with(ChainKind.WIRE, () =>
        buildWireOperatorWallets({ batchOps, underwriters, type })
      )
      .otherwise(() => {
        Assert.fail(
          `FlowTestContext.getWallet: unsupported chain ${ChainKind[chain]}`
        )
      })
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

}
