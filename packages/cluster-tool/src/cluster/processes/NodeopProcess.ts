import Assert from "node:assert"
import {
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { KeyType } from "@wireio/sdk-core"
import { execFile } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import { promisify } from "node:util"
import { asOption } from "@3fv/prelude-ts"
import { defaults, last } from "lodash"
import { match } from "ts-pattern"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import type { WireClient } from "../../clients/wire/WireClient.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { getLogger } from "../../logging/Logger.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import { probeEndpoint } from "../../utils/asyncUtils.js"
import { existsAsync, mkdirs } from "../../utils/fsUtils.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ManagedProcess } from "./ManagedProcess.js"
import type { ProcessManager } from "./ProcessManager.js"

const log = getLogger(__filename)

/** Plugins loaded on every node regardless of role. */
const AlwaysOnPlugins = [
  "sysio::net_plugin",
  "sysio::chain_api_plugin"
] as const
/** Plugins loaded only when the node has producers assigned. */
const ProducerPlugins = ["sysio::producer_plugin"] as const
/**
 * Plugins loaded after the standard argument block, on EVERY role
 * unconditionally. `sysio::trace_api_plugin` is deliberately NOT here — it is
 * gated by {@link NodeConfig.runsTraceApiPlugin} (SHARED-25 AC#4) and emitted
 * immediately after this block.
 */
const TrailingPlugins = ["sysio::producer_api_plugin"] as const

/** `[flag, value]` pair expansion helper. */
const pair = (flag: string, value: string): [string, string] => [flag, value]
/** `--plugin` expansion helper (readonly-array friendly). */
const pluginArgs = (plugins: readonly string[]): string[] =>
  plugins.flatMap(plugin => pair(NodeopProcess.PluginFlag, plugin))

const execFileAsync = promisify(execFile)
/** `--help` text per nodeop binary — probed once, shared by every node (capability detection). */
const binaryHelpCache = new Map<string, Promise<string>>()
function binaryHelp(binary: string): Promise<string> {
  return asOption(binaryHelpCache.get(binary)).getOrCall(() => {
    const helpText = execFileAsync(binary, [NodeopProcess.HelpFlag]).then(
      result => result.stdout,
      () => ""
    )
    binaryHelpCache.set(binary, helpText)
    return helpText
  })
}

/** nodeop chainbase map modes (closed set; spellings from chain_plugin's database-map-mode option). */
export enum DatabaseMapMode {
  mapped = "mapped",
  mapped_private = "mapped_private",
  heap = "heap",
  locked = "locked"
}

/**
 * The three SHARED-25 deadline knobs — optional in the RESOLVED shape
 * ("absent ⇒ flag omitted ⇒ nodeop default"), which is what makes the
 * phase/role matrix expressible at all: a `Required<>` config could only ever
 * pick a VALUE, never the "don't emit the flag" state the post-bootstrap form
 * needs. Split out of {@link NodeopTuningOptions} so
 * {@link NodeopTuningConfig} can require every OTHER tuning knob while leaving
 * exactly these three optional.
 */
export interface NodeopDeadlineOptions {
  /** `--max-transaction-time` — emitted ONLY on the bootstrap form (`-1`); post-bootstrap omits ⇒ stock 499 ms. */
  maxTransactionTime?: number
  /** `--abi-serializer-max-time-ms` — bootstrap: all roles 990_000; post-bootstrap: operator roles only. */
  abiSerializerMaxTimeMs?: number
  /** `--http-max-response-time-ms` — same phase/role matrix as above. */
  httpMaxResponseTimeMs?: number
}

/** Per-instance nodeop tuning knobs — every value configurable; defaults from the companion namespace. */
export interface NodeopTuningOptions extends NodeopDeadlineOptions {
  /** `--blocks-dir` (relative to the node's data dir). */
  blocksPath?: string
  /** `--vote-threads`. */
  voteThreads?: number
  /** `--p2p-max-nodes-per-host`. */
  p2pMaxNodesPerHost?: number
  /** `--max-clients`. */
  maxClients?: number
  /** `--connection-cleanup-period` (seconds). */
  connectionCleanupPeriodSec?: number
  /** `--database-map-mode`. */
  databaseMapMode?: DatabaseMapMode
  /** `--contracts-console` (default on). */
  contractsConsole?: boolean
}

/** Resolved tuning: every knob required EXCEPT the phase/role-gated deadlines. */
export interface NodeopTuningConfig
  extends
    Required<Omit<NodeopTuningOptions, keyof NodeopDeadlineOptions>>,
    NodeopDeadlineOptions {}

/**
 * The SHARED-25 deadline defaults for `node` at `postBootstrap` — the ONE place
 * the phase × role matrix lives.
 *
 * An ABSENT knob is not "no opinion": it is the instruction to OMIT the flag, so
 * nodeop's own stock default applies. Bootstrap therefore keeps the permissive
 * values on EVERY role, and post-bootstrap drops `--max-transaction-time`
 * everywhere while keeping the long serializer / response deadlines for the
 * non-public operator roles alone (SHARED-25 AC#3's exception — a batch
 * operator's / underwriter's OPP daemon serves nobody but itself).
 *
 * @param node - The node whose role selects the post-bootstrap arm.
 * @param postBootstrap - Whether this is a post-bootstrap launch form.
 * @returns The deadline knobs to default; every omitted key stays absent.
 */
function createNodeopDeadlineDefaultOptions(
  node: NodeConfig,
  postBootstrap: boolean
): NodeopDeadlineOptions {
  return match({
    postBootstrap,
    isOperator: NodeConfig.isOperatorRole(node.role)
  })
    .with({ postBootstrap: false }, () => ({
      maxTransactionTime: NodeopProcess.BootstrapMaxTransactionTime,
      abiSerializerMaxTimeMs: NodeopProcess.BootstrapAbiSerializerMaxTimeMs,
      httpMaxResponseTimeMs: NodeopProcess.BootstrapHttpMaxResponseTimeMs
    }))
    .with({ isOperator: true }, () => ({
      abiSerializerMaxTimeMs: NodeopProcess.OperatorAbiSerializerMaxTimeMs,
      httpMaxResponseTimeMs: NodeopProcess.OperatorHttpMaxResponseTimeMs
    }))
    .otherwise(() => ({}))
}

/**
 * Resolve the tuning defaults for `node` at `postBootstrap` (see the
 * companion-namespace constants). `p2pMaxNodesPerHost` AND `maxClients` are both
 * topology-derived from {@link NodeConfig.peerCapacity}: EVERY cluster node lives
 * on loopback in a full mesh, so each must accept inbound connections from the
 * whole planned topology (bios + producers + operators) plus headroom for
 * flow-provisioned ad-hoc daemons. A `p2pMaxNodesPerHost` of 1 leaves
 * late-joining nodes unable to sync ("Peer closed connection"); a `maxClients`
 * below the mesh size makes every node refuse the surplus dials, which freezes
 * LIB at scale (see {@link NodeConfig.peerCapacity} for the full failure chain).
 *
 * Every knob except the three deadlines is phase- AND role-independent —
 * `databaseMapMode` most pointedly (SHARED-28 applies to every node, both
 * commands, both phases). The deadlines come from
 * {@link createNodeopDeadlineDefaultOptions}.
 *
 * @param node - The node being launched (its `cluster` supplies the topology).
 * @param postBootstrap - Whether this is a post-bootstrap launch form.
 * @returns The resolved tuning defaults.
 */
export function createNodeopTuningDefaultOptions(
  node: NodeConfig,
  postBootstrap: boolean
): NodeopTuningConfig {
  return {
    blocksPath: NodeopProcess.DefaultBlocksPath,
    voteThreads: NodeopProcess.DefaultVoteThreads,
    p2pMaxNodesPerHost: NodeConfig.peerCapacity(node.cluster),
    maxClients: NodeConfig.peerCapacity(node.cluster),
    connectionCleanupPeriodSec: NodeopProcess.DefaultConnectionCleanupPeriodSec,
    databaseMapMode: NodeopProcess.DefaultDatabaseMapMode,
    contractsConsole: true,
    ...createNodeopDeadlineDefaultOptions(node, postBootstrap)
  }
}

/**
 * Caller options for a nodeop instance — a COMPOSITION of the domain types that
 * already describe it (never a flat primitive bag): the planned {@link NodeConfig}
 * (which carries its `cluster: ClusterConfig` — name, role, ports, peers,
 * producers, node dir, binaries, bind address, genesis), the {@link OperatorAccount}
 * the node acts for (a producer's carries the node-shared `wire`+`wireFinalizer` signing
 * keys; a batch/underwriter's carries `wire`+`ethereum`+`solana`; the bios node's
 * is the genesis producer with the dev keys), the typed
 * {@link NodeopTuningOptions}, and any OPP daemon extra args (operator nodes).
 * Every endpoint / path / flag derives INSIDE {@link NodeopProcess} from these
 * members.
 */
export interface NodeopOptions {
  /** The node this process realizes (its `cluster` supplies binaries + binding + genesis). */
  node: NodeConfig
  /**
   * The accounts this node acts for.
   *
   * A PRODUCING node carries one entry per hosted producer account: they share the node's
   * block-signing K1 (`setprodkeys` maps every producer on a node to it), but each owns its own
   * BLS finalizer key, because `regfinkey` enforces a global uniqueness check — siblings sharing
   * one finalizer key means only the first can ever register, and an unregistered producer holds
   * no rank position at all. A batch-operator / underwriter node carries exactly one entry; a
   * non-producing plain node carries none.
   */
  operators?: OperatorAccount[]
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
  /**
   * Post-bootstrap launch form — the SHARED-25 deadline rules apply (author
   * directive: the rules apply only after a complete bootstrap). Distinct from
   * {@link relaunch}, which only strips the one-shot genesis flags and is ALSO
   * set by in-bootstrap recovery.
   */
  postBootstrap?: boolean
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
    Assert.ok(
      await existsAsync(cluster.executables.nodeop),
      "nodeop binary not found"
    )
    Assert.ok(
      await existsAsync(ClusterConfigProvider.genesisFile(cluster)),
      "genesis.json not found"
    )
    Assert.ok(
      node.producers.length === 0 ||
        (options.operators != null &&
          options.operators.length === node.producers.length &&
          options.operators.every(operator => operator.wireFinalizer != null)),
      `nodeop ${node.name}: a producing node requires one producer OperatorAccount per hosted producer, each carrying wire + wireFinalizer keys (${node.producers.length} producers, ${options.operators?.length ?? 0} accounts)`
    )
    // IDENTITY, not just arity. `buildArgs` renders `--producer-name` from the OPERATORS while
    // every other consumer (key-store lookup, SSM secret ids, start.sh) reads `node.producers`, so
    // matching counts alone would let a caller hand over the right NUMBER of the wrong accounts --
    // or the right accounts in a different order -- and the node would sign for producers it holds
    // no slot for, silently, with every assertion satisfied.
    if (node.producers.length > 0) {
      // Matched on EITHER identifier, because `producers` is not uniformly one of them: a planned
      // producer node carries labels (and a producer never calls `roa::newuser`, so its label IS
      // its account), while the bios node carries the on-chain genesis producer name `sysio` under
      // the operator labelled `node_bios`. Requiring labels alone rejects the bios node outright.
      const { operators = [] } = options,
        unmatched = node.producers.filter(
          producer =>
            !operators.some(
              operator =>
                operator.label === producer || operator.account === producer
            )
        )
      Assert.ok(
        unmatched.length === 0,
        `nodeop ${node.name}: no hosted operator for producer(s) ${unmatched.join(", ")} — hosted ${operators
          .map(operator => `${operator.label}/${operator.account}`)
          .join(", ")}`
      )
    }
    // `buildArgs` renders ONE block-signing provider for the whole node, so every hosted account
    // must sign blocks with the same K1 — the one `regproducer` / `setprodkeys` registered for
    // each of them. A second key would leave its accounts' slots silently unproduced.
    Assert.ok(
      new Set((options.operators ?? []).map(operator => operator.wire.publicKey)).size <= 1,
      `nodeop ${node.name}: every hosted producer account must share the node's block-signing K1`
    )
    mkdirs(node.nodePath)
    return new NodeopProcess(
      manager,
      NodeopProcess.resolveConfig(options, {
        genesisTimestamp: NodeopProcess.readGenesisTimestamp(cluster),
        supportsTraceNoAbis: (
          await binaryHelp(cluster.executables.nodeop)
        ).includes(NodeopProcess.TraceNoAbisFlag)
      })
    )
  }

  private constructor(
    manager: ProcessManager,
    private readonly config: NodeopConfig
  ) {
    super(manager, {
      label: config.node.name,
      kind: ManagedProcess.Kind.nodeop
    })
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

  verifyReady(): Promise<boolean> {
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
    const tail = this.recentOutput.slice(
      -NodeopProcess.StartupFailureDetailLines
    )
    return Promise.resolve(
      tail.length === 0 ? null : `recent output:\n${tail.join("\n")}`
    )
  }

  /** Dial URL for this node's HTTP API — the bind address mapped through {@link toDialAddress}. */
  get httpUrl(): string {
    return toURL(
      this.config.node.ports.http,
      toDialAddress(this.config.node.cluster.bind.nodeop.address)
    )
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
    Assert.ok(response.ok, `${this.label} get_info answered ${response.status}`)
    const info = (await response.json()) as WireClient.GetInfoResponse
    return info.head_block_num
  }
}

export namespace NodeopProcess {
  export const DefaultBlocksPath = "blocks"
  export const DefaultVoteThreads = 4
  export const DefaultConnectionCleanupPeriodSec = 15
  /**
   * `--max-transaction-time` on the BOOTSTRAP launch form (`-1` = unlimited).
   *
   * The `Bootstrap*` trio below is deliberately permissive on EVERY role, per
   * the author's directive: "These rules only apply to `nodeop` instances
   * following a complete bootstrap; until that point none should be applied."
   * Bootstrap pushes `setcode` for a dozen system contracts and a long tail of
   * heavy setup transactions through nodes that are also syncing — a stock
   * 499 ms transaction deadline fails those outright, so the SHARED-25 limits
   * cannot be armed until the chain is up.
   *
   * Post-bootstrap this knob is ABSENT for every role, so the flag is omitted
   * and nodeop's own default applies.
   */
  export const BootstrapMaxTransactionTime = -1
  /** `--abi-serializer-max-time-ms` on the BOOTSTRAP launch form (see {@link BootstrapMaxTransactionTime}). */
  export const BootstrapAbiSerializerMaxTimeMs = 990_000
  /** `--http-max-response-time-ms` on the BOOTSTRAP launch form (see {@link BootstrapMaxTransactionTime}). */
  export const BootstrapHttpMaxResponseTimeMs = 990_000
  /**
   * `--abi-serializer-max-time-ms` on a POST-BOOTSTRAP operator node
   * (batch operator / underwriter).
   *
   * SHARED-25 AC#3 tightens the serializer / response deadlines for nodes that
   * serve a PUBLIC API; the `Operator*` pair is that AC's non-public exception.
   * An operator node's HTTP surface exists for its own co-located OPP daemon
   * (`batch_operator_plugin` / `underwriter_plugin`), whose envelope and table
   * reads are large and legitimately slow, so it keeps the long deadlines.
   * Bios / producer nodes get NEITHER value post-bootstrap — the flags are
   * omitted and nodeop's own defaults apply.
   */
  export const OperatorAbiSerializerMaxTimeMs = 990_000
  /** `--http-max-response-time-ms` on a POST-BOOTSTRAP operator node (see {@link OperatorAbiSerializerMaxTimeMs}). */
  export const OperatorHttpMaxResponseTimeMs = 990_000
  /**
   * `--database-map-mode` for EVERY nodeop node, both commands, both phases
   * (SHARED-28).
   *
   * Under {@link DatabaseMapMode.mapped_private} chainbase keeps its pages
   * PRIVATE and writes them back only at a CLEAN exit, so an unclean stop
   * (SIGKILL, OOM, host reset) discards every state change since that boot and
   * the next start comes up on a dirty/stale chainbase — which routes through
   * the {@link startWithRecovery} hard-replay path
   * ({@link HardReplayBlockchainFlag}) rather than resuming. The trade is
   * deliberate: private mapping keeps the node's dirty pages out of the shared
   * page cache, which is what makes many co-located nodes survivable on one
   * host, and a dev cluster can always replay from blocks.log.
   */
  export const DefaultDatabaseMapMode = DatabaseMapMode.mapped_private
  export const StartupTimeoutMs = 180_000
  /** Per-probe fetch timeout for the {@link NodeopProcess.head} reader (ms). */
  export const HeadProbeTimeoutMs = 2_000
  export const HealthCheckPath = "/v1/chain/get_info" as const
  /** trace_api_plugin raw-trace flag (capability-probed — see `supportsTraceNoAbis`). */
  export const TraceNoAbisFlag = "--trace-no-abis"
  /** nodeop's `--config-dir` flag (the directory holding `config.ini`). */
  export const ConfigDirFlag = "--config-dir"
  /** nodeop's `--data-dir` flag; nodeop creates the directory itself. */
  export const DataDirFlag = "--data-dir"
  /** nodeop's `--genesis-json` flag — one-shot, stripped by {@link buildRelaunchArgs}. */
  export const GenesisJsonFlag = "--genesis-json"
  /** nodeop's `--genesis-timestamp` flag — one-shot, stripped alongside the genesis. */
  export const GenesisTimestampFlag = "--genesis-timestamp"
  /**
   * nodeop's `--help` flag — THE one spelling of it, shared by both capability
   * probes: the BUILD-TIME one `binaryHelp` shells out for (whose text
   * `resolveConfig` matches {@link TraceNoAbisFlag} against) and the RUNTIME
   * one {@link traceNoAbisProbeTest} renders into a published `start.sh`. The
   * two must stay identical — a probe that asked nodeop a different question
   * than the build did would answer for a different capability.
   */
  export const HelpFlag = "--help"

  /**
   * The shell test a rendered `start.sh` evaluates to answer "does the nodeop
   * on THIS host know {@link TraceNoAbisFlag}?" — the run-time form of the
   * build-time `--help` probe `create` performs, so a published script is never
   * frozen to the build host's answer.
   *
   * CAPTURE then match — never `--help | grep -q` under `set -o pipefail`.
   * `grep -q` exits 0 the instant it matches, closing the pipe; nodeop's help
   * exceeds the 64 KiB pipe buffer, so it is still writing and dies of SIGPIPE
   * (141). `pipefail` promotes that to the pipeline's status, so the `&&` would
   * NOT fire — dropping the flag precisely when it IS supported, which
   * hard-fails trace_api_plugin init on builds that require it. A command
   * substitution has no such short-circuit.
   *
   * @param nodeopWord - The nodeop binary as ONE ready-to-execute shell word
   *   (already quoted / variable-expanded by the caller).
   * @returns The `[[ … ]]` test, true when the flag appears in `--help`.
   */
  export function traceNoAbisProbeTest(nodeopWord: string): string {
    return `[[ "$(${nodeopWord} ${HelpFlag} 2>/dev/null || true)" == *'${TraceNoAbisFlag}'* ]]`
  }
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
  /** `producer_api_plugin` resume endpoint — un-pauses block production. */
  export const ResumeProductionPath = "/v1/producer/resume" as const
  /** `producer_api_plugin` paused-state endpoint. */
  export const PausedPath = "/v1/producer/paused" as const
  /** Per-request timeout for {@link resumeProduction} (ms). */
  export const ResumeProductionTimeoutMs = 5_000
  /** The nodeop `--plugin` flag (appended per plugin; scanned by {@link requiredSignatureProviderPlugins}). */
  export const PluginFlag = "--plugin"
  /** The nodeop `--signature-provider` flag (scanned by {@link requiredSignatureProviderPlugins}). */
  export const SignatureProviderFlag = "--signature-provider"
  /**
   * Optional nodeop plugins by signature-provider SCHEME. `KEY` / `KIOD` are
   * built into `sysio::signature_provider_manager_plugin`; an `SSM:` spec
   * resolves through `sysio::signature_provider_ssm_plugin`, which must be
   * ENABLED via `--plugin` — otherwise provider creation aborts startup with
   * `plugin_config_exception (3110006): Signature-provider scheme "SSM" is
   * provided by plugin "sysio::signature_provider_ssm_plugin"`.
   */
  export const SignatureProviderSchemePlugins: Partial<
    Record<SignatureProviderType, string>
  > = {
    [SignatureProviderType.SSM]: "sysio::signature_provider_ssm_plugin"
  }

  /**
   * The scheme of a rendered `--signature-provider` spec value — the leading
   * token of its final `<SCHEME>:<data>` segment
   * (`<name>,<chain>,<type>,<pub>,SSM:<id>` → `SSM`; the SSM form the harness
   * renders is region-less). A spec whose final segment is not
   * `<SCHEME>:<data>`-shaped yields a token no scheme map contains — callers
   * treat that as "no optional plugin required".
   */
  function signatureProviderScheme(spec: string): string {
    return last(spec.split(",")).split(":")[0]
  }

  /**
   * The optional signature-provider plugins `args` requires but does not yet
   * enable: every `--signature-provider` value's scheme is mapped through
   * {@link SignatureProviderSchemePlugins}, minus plugins already present after
   * a `--plugin` flag. {@link buildArgs} appends these so an SSM cluster's
   * nodeop (producing nodes AND OPP operator daemons — their specs arrive via
   * `extraArgs`) loads `sysio::signature_provider_ssm_plugin`.
   *
   * @param args - The composed argv to scan.
   * @returns The missing `--plugin` values, deduplicated, in scan order.
   */
  export function requiredSignatureProviderPlugins(
    args: readonly string[]
  ): string[] {
    const valuesAfter = (flag: string): string[] =>
        args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : [])),
      enabled = new Set(valuesAfter(PluginFlag)),
      required = valuesAfter(SignatureProviderFlag)
        .map(
          spec =>
            SignatureProviderSchemePlugins[
              signatureProviderScheme(spec) as SignatureProviderType
            ]
        )
        .filter(plugin => plugin != null && !enabled.has(plugin))
    return [...new Set(required)]
  }

  /**
   * `initial_timestamp` from the cluster's genesis file — the one-shot value a
   * node is stamped with at first boot.
   *
   * @param cluster - The resolved cluster config.
   * @returns The genesis `initial_timestamp`.
   */
  export function readGenesisTimestamp(cluster: ClusterConfig): string {
    return JSON.parse(
      Fs.readFileSync(ClusterConfigProvider.genesisFile(cluster), "utf8")
    ).initial_timestamp
  }

  /**
   * Resolve caller options into a complete {@link NodeopConfig}. PURE — the two
   * values `create` obtains impurely (the genesis timestamp read off disk, the
   * `--help` capability probe) are INJECTED.
   *
   * Extracting this is what makes the `start.sh` argv trustworthy: if the
   * emitting step hand-built a config instead, the argv-equality test would
   * compare two argvs derived from two INDEPENDENTLY resolved configs and pass
   * while the configs themselves drifted.
   *
   * @param options - Caller options.
   * @param resolved - The impure values `create` obtained.
   * @returns The complete config.
   */
  /** The impure values `create` resolves (genesis read + `--help` capability probe). */
  export interface ResolvedInputs {
    genesisTimestamp: string
    supportsTraceNoAbis: boolean
  }

  export function resolveConfig(
    options: NodeopOptions,
    resolved: ResolvedInputs
  ): NodeopConfig {
    return {
      ...options,
      tuning: defaults(
        { ...options.tuning },
        createNodeopTuningDefaultOptions(
          options.node,
          options.postBootstrap ?? false
        )
      ),
      extraArgs: options.extraArgs ?? [],
      genesisTimestamp: resolved.genesisTimestamp,
      supportsTraceNoAbis: resolved.supportsTraceNoAbis
    }
  }

  /**
   * Build the full nodeop command-line (binary + args), matching the Python
   * launcher's `construct_command_line()` output — every value derived from the
   * composed {@link NodeConfig} + {@link ClusterKeyStore.ProducerKeySet}. The
   * producing-node block uses {@link KeyGenerator.toSignatureProvider}
   * (dispatched on each key's curve).
   *
   * NOTE the shape: this returns argv **WITH the binary at index 0** (unlike the
   * other daemons' `buildArgs`, which return args only). Callers wanting the
   * argv alone `.slice(1)`, and relaunch semantics come from
   * {@link buildRelaunchArgs} — `buildArgs` itself IGNORES `config.relaunch`.
   */
  export function buildArgs(config: NodeopConfig): string[] {
    const { node, operators = [], tuning } = config,
      cluster = node.cluster,
      listen = cluster.bind.nodeop.address,
      // Under KEY / KIOD the bios genesis key is the well-known dev pair and its
      // spec is rendered INLINE (`KEY:<private>`) — byte-identical to every
      // historical cluster, and never a kiod lookup for a key the wallet gets
      // imported anyway. Under SSM the bios key is GENERATED (or adopted) like
      // any other node key, so it uses the cluster's provider source and the
      // node fetches it from SSM at startup, exactly as producer nodes do.
      baseKeySourceFor = ClusterConfigProvider.signatureProviderSource(cluster),
      isInlineBios =
        node.role === NodeRole.bios &&
        cluster.signatureProvider.type !== SignatureProviderType.SSM,
      keySourceFor = (
        account: string,
        keyType: KeyType
      ): KeyGenerator.SignatureProviderSource =>
        isInlineBios
          ? KeyGenerator.DefaultKeySource
          : baseKeySourceFor(account, keyType),
      isProducing =
        node.producers.length > 0 &&
        operators.length > 0 &&
        operators.every(entry => entry.wireFinalizer != null)
    const args = [
      cluster.executables.nodeop,
      ...pair("--blocks-dir", tuning.blocksPath),
      ...pair("--p2p-listen-endpoint", `${listen}:${node.ports.p2p}`),
      ...pair(
        "--p2p-server-address",
        `${node.advertiseAddress}:${node.ports.p2p}`
      ),
      ...node.peerEndpoints.flatMap(peer => pair("--p2p-peer-address", peer)),
      ...(node.role === NodeRole.bios ? ["--enable-stale-production"] : []),
      ...pluginArgs(AlwaysOnPlugins),
      ...(isProducing
        ? [
            ...pluginArgs(ProducerPlugins),
            // ONE block-signing provider: the hosted accounts share the node's K1. It resolves
            // from the FIRST account's own label, not the node's — every one of an account's
            // keys is published under, and persisted against, its `publicationLabel`, so
            // splitting the two halves across two labels would leave one of them a dangling
            // custody reference.
            ...pair(
              SignatureProviderFlag,
              KeyGenerator.toSignatureProvider(
                operators[0].wire,
                undefined,
                keySourceFor(operators[0].publicationLabel, KeyType.K1)
              )
            ),
            // …and one finalizer provider per hosted account, each published under that
            // ACCOUNT's own name — the node's own BLS parameter is a different key.
            ...operators.flatMap(entry =>
              pair(
                SignatureProviderFlag,
                KeyGenerator.toSignatureProvider(
                  entry.wireFinalizer,
                  undefined,
                  keySourceFor(entry.publicationLabel, KeyType.BLS)
                )
              )
            ),
            ...operators.flatMap(entry => pair("--producer-name", entry.account))
          ]
        : []),
      ...pair("--vote-threads", String(tuning.voteThreads)),
      // SHARED-25: an ABSENT deadline is an instruction to OMIT the flag so
      // nodeop's own default applies — the post-bootstrap state for every role
      // these rules cover. Emitting a "default" value here instead would make
      // that state unreachable.
      ...(tuning.maxTransactionTime != null
        ? pair("--max-transaction-time", String(tuning.maxTransactionTime))
        : []),
      ...(tuning.abiSerializerMaxTimeMs != null
        ? pair(
            "--abi-serializer-max-time-ms",
            String(tuning.abiSerializerMaxTimeMs)
          )
        : []),
      ...pair("--p2p-max-nodes-per-host", String(tuning.p2pMaxNodesPerHost)),
      ...pair("--max-clients", String(tuning.maxClients)),
      ...pair(
        "--connection-cleanup-period",
        String(tuning.connectionCleanupPeriodSec)
      ),
      ...pair("--database-map-mode", tuning.databaseMapMode),
      // SHARED-31: UNIFORM across every node, both commands, both phases — so
      // it is read off the CLUSTER config, never a per-instance tuning knob.
      ...pair(
        `--${Constants.CHAIN_STATE_DB_SIZE_MB_OPTION}`,
        String(cluster.chainStateDbSizeMb)
      ),
      ...(tuning.contractsConsole ? ["--contracts-console"] : []),
      ...pluginArgs(TrailingPlugins),
      // SHARED-25 AC#4 (D3): local clusters keep trace_api on every role; the
      // production-shaped external tree drops it from bios / producer nodes.
      ...(NodeConfig.runsTraceApiPlugin(node)
        ? pluginArgs([Constants.TRACE_API_PLUGIN])
        : []),
      // The harness supplies no trace-api ABI set — serve raw traces. Newer
      // nodeop generations hard-fail trace_api_plugin init without this flag;
      // older ones reject the unknown option, hence the capability probe. The
      // flag belongs to the plugin, so it follows the SAME gate: nodeop rejects
      // it outright when trace_api_plugin is not loaded.
      ...(config.supportsTraceNoAbis && NodeConfig.runsTraceApiPlugin(node)
        ? [TraceNoAbisFlag]
        : []),
      // Same SHARED-25 omission rule as the two deadlines above.
      ...(tuning.httpMaxResponseTimeMs != null
        ? pair(
            "--http-max-response-time-ms",
            String(tuning.httpMaxResponseTimeMs)
          )
        : []),
      ...pair(ConfigDirFlag, node.nodePath),
      ...pair(DataDirFlag, node.nodePath),
      ...pair(GenesisJsonFlag, ClusterConfigProvider.genesisFile(cluster)),
      ...pair(GenesisTimestampFlag, config.genesisTimestamp),
      ...pair("--http-server-address", `${listen}:${node.ports.http}`),
      ...config.extraArgs
    ]
    // A --signature-provider spec's scheme may require an optional nodeop
    // plugin (SSM today) — scan the COMPOSED argv (extraArgs included, so
    // operator-daemon specs are covered) and enable what's missing.
    return [...args, ...pluginArgs(requiredSignatureProviderPlugins(args))]
  }

  /**
   * Flags whose `[flag, value]` pair is stripped on relaunch — genesis settings
   * are one-shot (replaying them re-stamps the chain).
   */
  const RelaunchStripFlags: ReadonlySet<string> = new Set([
    GenesisJsonFlag,
    GenesisTimestampFlag
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

  /** The node's finalizer safety file: `<nodePath>/finalizers/safety.dat`. */
  export function finalizerSafetyFile(
    nodePath: NodeConfig["nodePath"]
  ): string {
    return Path.join(nodePath, FinalizersDirname, SafetyDatFilename)
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
   * POST {@link ResumeProductionPath} against a producing node's HTTP
   * endpoint — un-pauses block production (a no-op if the node is already
   * unpaused). Used by `ClusterManager.run` after relaunching a producer so a
   * cluster that was gracefully stopped mid-production resumes producing.
   *
   * @param httpUrl - The node's HTTP dial URL (e.g. `NodeopProcess.httpUrl`).
   */
  export async function resumeProduction(httpUrl: string): Promise<void> {
    const response = await fetch(`${httpUrl}${ResumeProductionPath}`, {
      method: "POST",
      signal: AbortSignal.timeout(ResumeProductionTimeoutMs)
    })
    Assert.ok(
      response.ok,
      `resumeProduction: ${httpUrl}${ResumeProductionPath} answered ${response.status}`
    )
  }

  /**
   * The {@link NodeopOptions} for relaunching an ALREADY-BOOTSTRAPPED node —
   * the ONE assembly both post-bootstrap relaunch paths use:
   * `ClusterManager.run`'s per-node start and `NodeopProcessSteps.runRestart`.
   *
   * Both flags are load-bearing and INDEPENDENT:
   *
   * - `relaunch: true` strips the one-shot genesis flags (replaying them
   *   re-stamps the chain).
   * - `postBootstrap: true` arms the SHARED-25 deadline rules. It is NOT
   *   implied by `relaunch`, which in-bootstrap dirty-chainbase recovery also
   *   sets — which is exactly why the pair lives here instead of being spelled
   *   out at each call site, where one of them could silently go missing.
   *
   * The operator + daemon args are RESOLVED BY THE CALLER (both resolve them
   * through the same `NodeopProcessSteps.resolveOperator` /
   * `resolveOperatorDaemonArgs` pair) rather than here, so this module keeps no
   * dependency on the orchestration layer that imports it.
   *
   * @param node - The planned node being relaunched.
   * @param operators - The accounts that node acts for (one per hosted producer).
   * @param extraArgs - Its OPP daemon args (empty for bios / producer nodes).
   * @returns The post-bootstrap relaunch options.
   */
  export function createRelaunchOptions(
    node: NodeConfig,
    operators: OperatorAccount[],
    extraArgs: string[]
  ): NodeopOptions {
    return { node, operators, extraArgs, relaunch: true, postBootstrap: true }
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
      const safetyFile = finalizerSafetyFile(options.node.nodePath)
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
