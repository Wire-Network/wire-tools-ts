import Assert from "node:assert"
import { execFile } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { promisify } from "node:util"
import { asOption } from "@3fv/prelude-ts"
import { defaults } from "lodash"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import type { WireClient } from "../../clients/wire/WireClient.js"
import type { ClusterConfig } from "../../config/ClusterConfig.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { getLogger } from "../../logging/Logger.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync, mkdirs } from "../../utils/fsUtils.js"
import { Localhost, toURL } from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

const log = getLogger(__filename)

/** Plugins loaded on every node regardless of role. */
const AlwaysOnPlugins = ["sysio::net_plugin", "sysio::chain_api_plugin"] as const
/** Plugins loaded only when the node has producers assigned. */
const ProducerPlugins = ["sysio::producer_plugin"] as const
/** Plugins loaded after the standard argument block. */
const TrailingPlugins = [
  "sysio::producer_api_plugin",
  "sysio::trace_api_plugin"
] as const

/** `[flag, value]` pair expansion helper. */
const pair = (flag: string, value: string): [string, string] => [flag, value]
/** `--plugin` expansion helper (readonly-array friendly). */
const pluginArgs = (plugins: readonly string[]): string[] =>
  plugins.flatMap(plugin => pair("--plugin", plugin))

const execFileAsync = promisify(execFile)
/** `--help` text per nodeop binary — probed once, shared by every node (capability detection). */
const binaryHelpCache = new Map<string, Promise<string>>()
function binaryHelp(binary: string): Promise<string> {
  return asOption(binaryHelpCache.get(binary)).getOrCall(() => {
    const helpText = execFileAsync(binary, ["--help"]).then(
      result => result.stdout,
      () => ""
    )
    binaryHelpCache.set(binary, helpText)
    return helpText
  })
}

/** Per-instance nodeop tuning knobs — every value configurable; defaults from the companion namespace. */
export interface NodeopTuningOptions {
  /** `--blocks-dir` (relative to the node's data dir). */
  blocksPath?: string
  /** `--vote-threads`. */
  voteThreads?: number
  /** `--max-transaction-time`. */
  maxTransactionTime?: number
  /** `--abi-serializer-max-time-ms`. */
  abiSerializerMaxTimeMs?: number
  /** `--p2p-max-nodes-per-host`. */
  p2pMaxNodesPerHost?: number
  /** `--max-clients`. */
  maxClients?: number
  /** `--connection-cleanup-period` (seconds). */
  connectionCleanupPeriodSec?: number
  /** `--http-max-response-time-ms`. */
  httpMaxResponseTimeMs?: number
  /** `--contracts-console` (default on). */
  contractsConsole?: boolean
}

/** Resolved tuning (defaults applied). */
export interface NodeopTuningConfig extends Required<NodeopTuningOptions> {}

/**
 * Resolve the tuning defaults for `cluster` (see the companion-namespace
 * constants). `p2pMaxNodesPerHost` is topology-derived: EVERY cluster node lives
 * on loopback, so each node must accept inbound connections from the whole
 * planned topology (bios + producers + operators) plus headroom for
 * flow-provisioned ad-hoc daemons — a limit of 1 leaves late-joining nodes
 * unable to sync (their dials get "Peer closed connection").
 */
export function createNodeopTuningDefaultOptions(cluster: ClusterConfig): NodeopTuningConfig {
  return {
    blocksPath: NodeopProcess.DefaultBlocksPath,
    voteThreads: NodeopProcess.DefaultVoteThreads,
    maxTransactionTime: NodeopProcess.DefaultMaxTransactionTime,
    abiSerializerMaxTimeMs: NodeopProcess.DefaultAbiSerializerMaxTimeMs,
    p2pMaxNodesPerHost:
      cluster.nodeCount +
      cluster.batchOperatorCount +
      cluster.underwriterCount +
      NodeopProcess.BiosNodeCount +
      NodeopProcess.AdHocDaemonPeerHeadroom,
    maxClients: NodeopProcess.DefaultMaxClients,
    connectionCleanupPeriodSec: NodeopProcess.DefaultConnectionCleanupPeriodSec,
    httpMaxResponseTimeMs: NodeopProcess.DefaultHttpMaxResponseTimeMs,
    contractsConsole: true
  }
}

/**
 * Caller options for a nodeop instance — a COMPOSITION of the domain types that
 * already describe it (never a flat primitive bag): the planned {@link NodeConfig}
 * (which carries its `cluster: ClusterConfig` — name, role, ports, peers,
 * producers, node dir, binaries, bind address, genesis), the {@link OperatorAccount}
 * the node acts for (a producer's carries the node-shared `wire`+`bls` signing
 * keys; a batch/underwriter's carries `wire`+`ethereum`+`solana`; the bios node's
 * is the genesis producer with the dev keys), the typed
 * {@link NodeopTuningOptions}, and any OPP daemon extra args (operator nodes).
 * Every endpoint / path / flag derives INSIDE {@link NodeopProcess} from these
 * members.
 */
export interface NodeopOptions {
  /** The node this process realizes (its `cluster` supplies binaries + binding + genesis). */
  node: NodeConfig
  /** The operator this node acts for — required when `node.producers` is non-empty. */
  operator?: OperatorAccount
  /** Per-instance tuning overrides (defaults from the companion namespace). */
  tuning?: NodeopTuningOptions
  /** OPP daemon extra args (operator nodes — see `OperatorDaemonTool`). */
  extraArgs?: string[]
  /**
   * Second-boot mode: the node's data dir already carries a synced chain, so
   * the one-shot genesis flags are stripped ({@link NodeopProcess.buildRelaunchArgs}).
   * Used by the restart step — a plugin whose startup preflight reads the
   * node's LOCAL chain state (underwriter_plugin) only sees bootstrap-written
   * state on a boot that REPLAYS it.
   */
  relaunch?: boolean
}

/** Resolved nodeop config — options with tuning defaults applied + the launch-time genesis timestamp. */
export interface NodeopConfig extends NodeopOptions {
  tuning: NodeopTuningConfig
  extraArgs: string[]
  /** `initial_timestamp` read from the cluster genesis at create time. */
  genesisTimestamp: string
  /**
   * Whether this nodeop generation knows `--trace-no-abis` (capability-probed
   * via `--help`): newer builds hard-fail trace_api_plugin init WITHOUT it;
   * older builds hard-fail on the unknown option WITH it.
   */
  supportsTraceNoAbis: boolean
}

/**
 * Manages a nodeop instance. Folds the former `cluster/startCmd.ts` — its
 * argv builder becomes {@link args}, deriving everything from the composed
 * {@link NodeConfig} (endpoints from `node.ports` + the cluster bind address,
 * signature providers via {@link KeyGenerator.toSignatureProvider}). Many
 * instances coexist (one per node), each labeled by `node.name`.
 */
export class NodeopProcess extends ManagedProcess {
  static async create(
    manager: ProcessManager,
    options: NodeopOptions
  ): Promise<NodeopProcess> {
    const { node } = options,
      cluster = node.cluster
    Assert.ok(await existsAsync(cluster.executables.nodeop), "nodeop binary not found")
    Assert.ok(await existsAsync(cluster.genesisFile), "genesis.json not found")
    Assert.ok(
      node.producers.length === 0 ||
        (options.operator != null && options.operator.bls != null),
      `nodeop ${node.name}: a producing node requires a producer OperatorAccount (wire + bls keys)`
    )
    mkdirs(node.nodePath)
    const config: NodeopConfig = {
      ...options,
      tuning: defaults({ ...options.tuning }, createNodeopTuningDefaultOptions(cluster)),
      extraArgs: options.extraArgs ?? [],
      genesisTimestamp: JSON.parse(Fs.readFileSync(cluster.genesisFile, "utf8"))
        .initial_timestamp,
      supportsTraceNoAbis: (await binaryHelp(cluster.executables.nodeop)).includes(
        NodeopProcess.TraceNoAbisFlag
      )
    }
    return new NodeopProcess(manager, config)
  }

  private constructor(
    manager: ProcessManager,
    private readonly config: NodeopConfig
  ) {
    super(manager, { label: config.node.name, kind: ManagedProcess.Kind.nodeop })
  }

  get exe(): string {
    return this.config.node.cluster.executables.nodeop
  }

  /** The full nodeop argv (ported from `buildStartCmd`), without the binary —
   *  relaunch mode strips the one-shot genesis flags. */
  get args(): string[] {
    const startArgs = NodeopProcess.buildArgs(this.config).slice(1)
    return this.config.relaunch
      ? NodeopProcess.buildRelaunchArgs(startArgs)
      : startArgs
  }

  protected get verifyTimeoutMs(): number {
    return NodeopProcess.StartupTimeoutMs
  }

  protected verifyReady(): Promise<boolean> {
    return probeEndpoint(`${this.httpUrl}${NodeopProcess.HealthCheckPath}`)
  }

  /**
   * Startup-failure context: nodeop's abort reason (e.g. chainbase's
   * `database dirty flag set` after an unclean shutdown, a plugin init
   * failure, a rejected option) arrives on the captured stderr — surface the
   * recent-output tail directly in the rejection instead of pointing at a log
   * file.
   */
  protected startupFailureDetail(): Promise<string> {
    const tail = this.recentOutput.slice(-NodeopProcess.StartupFailureDetailLines)
    return Promise.resolve(
      tail.length === 0 ? null : `recent output:\n${tail.join("\n")}`
    )
  }

  /** Loopback dial URL for this node's HTTP API. */
  get httpUrl(): string {
    return toURL(this.config.node.ports.http, Localhost)
  }

  /**
   * THIS node's current head block, read from its own `get_info` — the node's
   * LOCAL view, which lags the producer until p2p sync catches up. The restart
   * step's sync gate polls this against the depot head.
   */
  async head(): Promise<number> {
    const response = await fetch(
      `${this.httpUrl}${NodeopProcess.HealthCheckPath}`,
      { signal: AbortSignal.timeout(NodeopProcess.HeadProbeTimeoutMs) }
    )
    Assert.ok(
      response.ok,
      `${this.label} get_info answered ${response.status}`
    )
    const info = (await response.json()) as WireClient.GetInfoResponse
    return info.head_block_num
  }
}

export namespace NodeopProcess {
  export const DefaultBlocksPath = "blocks"
  export const DefaultVoteThreads = 4
  export const DefaultMaxTransactionTime = -1
  export const DefaultAbiSerializerMaxTimeMs = 990_000
  /** The bios node's contribution to the loopback peer allowance. */
  export const BiosNodeCount = 1
  /** Extra loopback inbound slots for flow-provisioned ad-hoc daemons. */
  export const AdHocDaemonPeerHeadroom = 3
  export const DefaultMaxClients = 25
  export const DefaultConnectionCleanupPeriodSec = 15
  export const DefaultHttpMaxResponseTimeMs = 990_000
  export const StartupTimeoutMs = 180_000
  /** Per-probe fetch timeout for the {@link NodeopProcess.head} reader (ms). */
  export const HeadProbeTimeoutMs = 2_000
  export const HealthCheckPath = "/v1/chain/get_info" as const
  /** trace_api_plugin raw-trace flag (capability-probed — see `supportsTraceNoAbis`). */
  export const TraceNoAbisFlag = "--trace-no-abis"
  /** nodeop recovery flag: wipe state, recover what blocks.log holds, replay with full validation. */
  export const HardReplayBlockchainFlag = "--hard-replay-blockchain"
  /** chainbase's startup-abort line after an unclean shutdown (`pinnable_mapped_file.cpp`). */
  export const DirtyChainbasePattern = /database dirty flag set/
  /** Captured-output lines surfaced by {@link NodeopProcess.startupFailureDetail}. */
  export const StartupFailureDetailLines = 20
  /** `--finalizers-dir` default under the node's data dir (wire-sysio `config.hpp`). */
  export const FinalizersDirname = "finalizers"
  /** Finalizer safety information file (fsi) inside {@link FinalizersDirname}. */
  export const SafetyDatFilename = "safety.dat"

  /**
   * Build the full nodeop command-line (binary + args), matching the Python
   * launcher's `construct_command_line()` output — every value derived from the
   * composed {@link NodeConfig} + {@link ClusterKeyStore.ProducerKeySet}. The
   * producing-node block uses {@link KeyGenerator.toSignatureProvider}
   * (dispatched on each key's curve).
   */
  export function buildArgs(config: NodeopConfig): string[] {
    const { node, operator, tuning } = config,
      cluster = node.cluster,
      listen = cluster.bind.nodeop.address,
      isProducing = node.producers.length > 0 && operator != null && operator.bls != null
    return [
      cluster.executables.nodeop,
      ...pair("--blocks-dir", tuning.blocksPath),
      ...pair("--p2p-listen-endpoint", `${listen}:${node.ports.p2p}`),
      ...pair("--p2p-server-address", `${Localhost}:${node.ports.p2p}`),
      ...node.peerEndpoints.flatMap(peer => pair("--p2p-peer-address", peer)),
      ...(node.role === NodeRole.bios ? ["--enable-stale-production"] : []),
      ...pluginArgs(AlwaysOnPlugins),
      ...(isProducing
        ? [
            ...pluginArgs(ProducerPlugins),
            ...pair("--signature-provider", KeyGenerator.toSignatureProvider(operator.wire)),
            ...pair("--signature-provider", KeyGenerator.toSignatureProvider(operator.bls)),
            ...node.producers.flatMap(name => pair("--producer-name", name))
          ]
        : []),
      ...pair("--vote-threads", String(tuning.voteThreads)),
      ...pair("--max-transaction-time", String(tuning.maxTransactionTime)),
      ...pair("--abi-serializer-max-time-ms", String(tuning.abiSerializerMaxTimeMs)),
      ...pair("--p2p-max-nodes-per-host", String(tuning.p2pMaxNodesPerHost)),
      ...pair("--max-clients", String(tuning.maxClients)),
      ...pair("--connection-cleanup-period", String(tuning.connectionCleanupPeriodSec)),
      ...(tuning.contractsConsole ? ["--contracts-console"] : []),
      ...pluginArgs(TrailingPlugins),
      // The harness supplies no trace-api ABI set — serve raw traces. Newer
      // nodeop generations hard-fail trace_api_plugin init without this flag;
      // older ones reject the unknown option, hence the capability probe.
      ...(config.supportsTraceNoAbis ? [TraceNoAbisFlag] : []),
      ...pair("--http-max-response-time-ms", String(tuning.httpMaxResponseTimeMs)),
      ...pair("--config-dir", node.nodePath),
      ...pair("--data-dir", node.nodePath),
      ...pair("--genesis-json", cluster.genesisFile),
      ...pair("--genesis-timestamp", config.genesisTimestamp),
      ...pair("--http-server-address", `${listen}:${node.ports.http}`),
      ...config.extraArgs
    ]
  }

  /**
   * Flags whose `[flag, value]` pair is stripped on relaunch — genesis settings
   * are one-shot (replaying them re-stamps the chain).
   */
  const RelaunchStripFlags: ReadonlySet<string> = new Set([
    "--genesis-json",
    "--genesis-timestamp"
  ])
  const EnableStaleProductionFlag = "--enable-stale-production"

  /**
   * Build a relaunch argv from a captured original — strips one-shot genesis
   * flags and idempotently appends `--enable-stale-production` so a restarted
   * producer can resume.
   */
  export function buildRelaunchArgs(originalArgs: string[]): string[] {
    const stripped = originalArgs.flatMap((arg, index, all) => {
      if (RelaunchStripFlags.has(all[index - 1])) return []
      if (RelaunchStripFlags.has(arg)) return []
      return [arg]
    })
    return stripped.includes(EnableStaleProductionFlag)
      ? stripped
      : [...stripped, EnableStaleProductionFlag]
  }

  /** The node's finalizer safety file: `<data-dir>/finalizers/safety.dat`. */
  export function finalizerSafetyFile(node: Pick<NodeConfig, "nodePath">): string {
    return Path.join(node.nodePath, FinalizersDirname, SafetyDatFilename)
  }

  /**
   * The startup-outcome surface {@link isDirtyChainbaseAbort} inspects —
   * structurally satisfied by any {@link ManagedProcess}.
   */
  export interface StartupOutcome {
    isRunning: boolean
    recentOutput: readonly string[]
  }

  /**
   * Whether a failed start was chainbase's dirty-flag abort (state left by an
   * unclean shutdown): the child EXITED and its captured output carries
   * {@link DirtyChainbasePattern}. A live-but-slow node never matches.
   */
  export function isDirtyChainbaseAbort(candidate: StartupOutcome): boolean {
    return (
      !candidate.isRunning &&
      candidate.recentOutput.some(line => DirtyChainbasePattern.test(line))
    )
  }

  /**
   * Create + start a nodeop, recovering ONCE from a dirty chainbase.
   *
   * An unclean shutdown (SIGKILL mid chainbase-flush) leaves the state dirty,
   * so the next boot aborts with `database dirty flag set` — and the
   * reversible blocks / fork_db.dat are already lost. Recovery relaunches with
   * {@link HardReplayBlockchainFlag} (wipe state, replay from blocks.log) and
   * first removes the node's finalizer safety file: hard replay discards the
   * reversible blocks the fsi lock points into, and a finalizer locked on a
   * discarded block can never vote again (its liveness AND safety checks both
   * fail), which stalls finality cluster-wide and pauses every producer with
   * `Not producing block because no recent votes received`. Wiping the fsi is
   * the documented dev-cluster recovery (wire-sysio `disaster_recovery_3.py`);
   * a production finalizer must NEVER do this. The retry runs in relaunch mode
   * — a dirty chainbase implies an existing chain, so the one-shot genesis
   * flags are stale.
   *
   * @param manager - The registry the processes register with.
   * @param options - Same options as {@link NodeopProcess.create}.
   */
  export async function startWithRecovery(
    manager: ProcessManager,
    options: NodeopOptions
  ): Promise<NodeopProcess> {
    const first = await NodeopProcess.create(manager, options)
    try {
      return await first.start()
    } catch (error) {
      if (!isDirtyChainbaseAbort(first)) throw error
      const safetyFile = finalizerSafetyFile(options.node)
      // force:true tolerates a missing file; any OTHER rm failure (EACCES,
      // EISDIR, EIO) must abort recovery — a surviving stale fsi keeps the
      // finality lock this wipe exists to clear, and hard replay would
      // relaunch straight back into the cluster-wide stall.
      Fs.rmSync(safetyFile, { force: true })
      manager.remove(first.label)
      log.warn(
        `${first.label}: chainbase dirty from an unclean shutdown — relaunching with ${HardReplayBlockchainFlag} (stale ${safetyFile} removed)`
      )
      const retry = await NodeopProcess.create(manager, {
        ...options,
        relaunch: true,
        extraArgs: [...(options.extraArgs ?? []), HardReplayBlockchainFlag]
      })
      return retry.start()
    }
  }
}
