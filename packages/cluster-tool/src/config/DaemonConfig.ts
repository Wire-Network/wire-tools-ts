import Path from "node:path"
import type { BindConfigDaemon, ClusterConfig } from "@wireio/cluster-tool-shared"
import { AnvilProcess, type AnvilConfig } from "../cluster/processes/AnvilProcess.js"
import { KiodProcess, type KiodConfig } from "../cluster/processes/KiodProcess.js"
import { NodeopProcess, type NodeopConfig } from "../cluster/processes/NodeopProcess.js"
import { SolanaValidatorProcess, type SolanaValidatorConfig } from "../cluster/processes/SolanaValidatorProcess.js"
import { matchesPrefix, StartScriptVariable, type StartScriptRelocation } from "../utils/startScriptUtils.js"
import { NodeConfig } from "./NodeConfig.js"

/**
 * Which daemon a {@link DaemonConfig} describes.
 *
 * The first four are {@link ManagedProcess}-backed — the harness spawns them, so
 * their directory and argv DERIVE from the process. `debuggingServer` is not: it
 * runs in-process inside the harness (no label, no pidfile, no spawned argv), so
 * its directory and command are DECLARED here instead.
 */
export enum DaemonKind {
  node = "node",
  anvil = "anvil",
  solanaValidator = "solanaValidator",
  kiod = "kiod",
  debuggingServer = "debuggingServer"
}

/**
 * A conditional argv segment that must render as SHELL rather than freeze to
 * whatever was true on the build host.
 *
 * Freezing a build-time conditional is the sharpest failure mode this whole
 * feature has: anvil's `--load-state` is absent at create time (the state file
 * does not exist yet), so a frozen script would restart anvil with NO deployed
 * outpost contracts while the depot still holds their addresses — surfacing as
 * an OPP circulation stall, never as a startup error.
 */
export interface DaemonArgvCondition {
  /** Shell test emitted verbatim (e.g. `[ -f "$STATE" ]`). */
  readonly test: string
  /**
   * The exact argv tokens this condition governs. The renderer REMOVES them
   * from the unconditional argv (as a contiguous run, if the build host
   * happened to produce them) and re-emits them under {@link test}.
   *
   * Contiguous-run removal — not by-value removal — is required: anvil passes
   * the SAME state-file path to both `--dump-state` and `--load-state`, so
   * dropping every occurrence of that path would silently break `--dump-state`.
   */
  readonly tokens: readonly string[]
}

/**
 * One daemon of a cluster: where its directory is, what it runs, and the
 * conditionals its start script must evaluate at run time rather than inherit.
 *
 * ONE enumeration ({@link DaemonConfig.plan}) drives all three consumers —
 * `create` emission, `create-external-config` Rebind re-render, and the Verify
 * scan. A node-only fix reaches 1 of 5 daemon kinds and ships the rest stale,
 * which is the exact defect this type exists to prevent.
 */
export interface DaemonConfig {
  readonly kind: DaemonKind
  /** Process label (`ManagedProcess.label`) — the node name for a node. */
  readonly label: string
  /**
   * The daemon's own directory, `<cluster>/data/<label with dashes→underscores>`
   * for a {@link ManagedProcess} (mirroring `ManagedProcess.pidFile`), and the
   * declared directory for the debugging server.
   */
  readonly daemonPath: string
  /** Absolute executable on the BUILD host — relocated by the renderer. */
  readonly exe: string
  /**
   * For an executable resolved from `PATH` rather than from a relocatable root
   * (anvil, solana-test-validator), the command name to re-resolve at run time.
   *
   * Freezing the build host's path is wrong for exactly these: `which("anvil")`
   * yields e.g. `/home/<user>/.foundry/bin/anvil`, which sits under NO cluster
   * or repo root and so cannot be relocated — and almost certainly does not
   * exist on the deploy host. The renderer emits
   * `"${WIRE_ANVIL_BIN:-$(command -v anvil)}"` instead: an explicit override,
   * else whatever the operator's PATH provides.
   */
  readonly exeCommandName?: string
  /** Environment variable that overrides {@link exeCommandName}'s resolution. */
  readonly exeEnvironmentVariable?: string
  /** Unconditional argv (WITHOUT the executable), in RUN — not create — form. */
  readonly argv: readonly string[]
  /** Extra environment entries the live process merges over its inherited env. */
  readonly env?: Readonly<Record<string, string>>
  /** Conditionals the script evaluates itself (see {@link DaemonArgvCondition}). */
  readonly conditions: readonly DaemonArgvCondition[]
  /**
   * Extra relocations beyond the cluster-wide table — the per-daemon root that
   * `$NODE_DIR` stands for. Absent for kiod, whose argv addresses
   * `<cluster>/wallet` and never its own `data/kiod` directory (that holds only
   * its pidfile and log).
   */
  readonly relocations: readonly StartScriptRelocation[]
}

/**
 * The already-resolved per-daemon configs a {@link DaemonConfig.plan} is built
 * from. Each is the SAME config its live process spawns from — rebuilt through
 * the daemon's pure `resolveConfig`, never hand-assembled — so the rendered
 * script and the spawned process cannot drift.
 *
 * Every member is optional because a cluster does not run every daemon:
 * external-outpost mode has no local anvil or validator, and a cluster with the
 * debugging server disabled has no bundled server.
 */
export interface DaemonConfigSources {
  /** One per planned wire node, in `NodeConfig.plan` order. */
  readonly nodeop: readonly NodeopConfig[]
  readonly anvil?: AnvilConfig
  readonly solanaValidator?: SolanaValidatorConfig
  readonly kiod?: KiodConfig
  /** The bundled debugging server's listen binding (absent when disabled). */
  readonly debuggingServer?: BindConfigDaemon
}

export namespace DaemonConfig {
  /** Filename of the emitted start script, in every daemon directory. */
  export const StartScriptFilename = "start.sh"

  /** `node` executable that runs the bundled debugging server. */
  export const NodeExecutable = "node"

  /**
   * Env vars overriding a rendered script's PATH-resolved executable.
   *
   * `WIRE_`-PREFIXED deliberately. The obvious names collide with variables the
   * environment already defines for other purposes: `NODE_BIN` is set by common
   * node version managers to the bin DIRECTORY, so an unprefixed
   * `"${NODE_BIN:-$(command -v node)}"` never reaches its fallback and execs a
   * directory — `cannot execute: Is a directory`. Found by running a real
   * emitted script, not by reading it.
   */
  export const AnvilBinEnvironmentVariable = "WIRE_ANVIL_BIN"

  /** Env var overriding the solana-test-validator binary a rendered script execs. */
  export const SolanaValidatorBinEnvironmentVariable = "WIRE_SOLANA_TEST_VALIDATOR_BIN"

  /** Env var overriding the `node` binary a rendered script execs. */
  export const NodeBinEnvironmentVariable = "WIRE_NODE_BIN"

  /** Bundled debugging-server entry point, inside {@link DebuggingServerSubpath}. */
  export const DebuggingServerBundleFilename = "wire-debugging-server.cjs"

  /** The bundled server's `start` subcommand. */
  export const DebuggingServerStartCommand = "start"

  /**
   * Which daemons a cluster of this SHAPE runs, by label — a pure function of
   * the config, with no resolved per-daemon inputs required.
   *
   * This exists so the plan-time phase composition (which has only a
   * `ClusterConfig`) and the run-time {@link plan} (which needs resolved
   * sources) cannot disagree about the daemon SET. Re-deriving the
   * local/external and debugging-server branching in a second place is exactly
   * the coupling this type exists to delete — and a mismatch would surface as
   * an emit step that writes no file.
   *
   * @param config - The resolved cluster config.
   * @returns The daemon labels, in {@link plan} order.
   */
  export function plannedLabels(config: ClusterConfig): string[] {
    const isExternalOutpost = config.externalOutposts != null
    return [
      ...NodeConfig.plan(config).map(node => node.name),
      // External-outpost clusters run against REMOTE chains — no local anvil
      // or validator exists, so neither gets a script.
      ...(isExternalOutpost ? [] : [AnvilProcess.ProcessLabel, SolanaValidatorProcess.ProcessLabel]),
      KiodProcess.ProcessLabel,
      ...(config.debuggingServerEnabled === false ? [] : [DebuggingServerSubpath])
    ]
  }

  /**
   * Enumerate every daemon of a cluster — the ONE list that drives `create`
   * emission, `create-external-config` Rebind, and the Verify scan.
   *
   * @param config - The resolved cluster config.
   * @param sources - The per-daemon resolved configs (see {@link DaemonConfigSources}).
   * @returns One descriptor per daemon this cluster actually runs.
   */
  export function plan(config: ClusterConfig, sources: DaemonConfigSources): DaemonConfig[] {
    return [
      ...sources.nodeop.map(nodeop => planNode(nodeop)),
      ...(sources.anvil == null ? [] : [planAnvil(config, sources.anvil)]),
      ...(sources.solanaValidator == null ? [] : [planSolanaValidator(config, sources.solanaValidator)]),
      ...(sources.kiod == null ? [] : [planKiod(config, sources.kiod)]),
      ...(sources.debuggingServer == null ? [] : [planDebuggingServer(config, sources.debuggingServer)])
    ]
  }

  /**
   * A wire node. Its argv is the RELAUNCH form — a `start.sh` restarts an
   * existing node, and replaying the one-shot genesis flags would re-stamp the
   * chain. `--trace-no-abis` is capability-probed on the BUILD host, so it
   * renders as a run-time probe instead of freezing today's answer.
   */
  function planNode(nodeop: NodeopConfig): DaemonConfig {
    const { node } = nodeop,
      cluster = node.cluster,
      nodeopBinary = cluster.executables.nodeop,
      // buildArgs returns argv WITH the binary at index 0; relaunch stripping
      // lives in buildRelaunchArgs, which `buildArgs` itself does NOT apply.
      argv = NodeopProcess.buildRelaunchArgs(
        NodeopProcess.buildArgs({
          ...nodeop,
          supportsTraceNoAbis: false
        }).slice(1)
      )
    return {
      kind: DaemonKind.node,
      label: node.name,
      daemonPath: node.nodePath,
      exe: nodeopBinary,
      argv,
      conditions: [
        {
          // CAPTURE then match — never `--help | grep -q` under `set -o
          // pipefail`. `grep -q` exits 0 the instant it matches, closing the
          // pipe; nodeop's help exceeds the 64 KiB pipe buffer, so it is still
          // writing and dies of SIGPIPE (141). `pipefail` promotes that to the
          // pipeline's status, so the `&&` would NOT fire — dropping the flag
          // precisely when it IS supported, which is the opposite of the
          // intent and hard-fails trace_api_plugin init on builds that require
          // it. A command substitution has no such short-circuit.
          test: `[[ "$("${quoteForTest(nodeopBinary, StartScriptVariable.WIRE_PREFIX_PATH, cluster.buildPath)}" --help 2>/dev/null || true)" == *'${NodeopProcess.TraceNoAbisFlag}'* ]]`,
          tokens: [NodeopProcess.TraceNoAbisFlag]
        }
      ],
      relocations: [{ prefix: node.nodePath, variable: StartScriptVariable.NODE_DIR }]
    }
  }

  /**
   * The local anvil. Rendered from its RUN config (interval mining on): the
   * create path deliberately runs it instamine because the hardhat outpost
   * deploy depends on that, but a relaunch never re-runs the deploy and must
   * emulate finality.
   */
  function planAnvil(config: ClusterConfig, anvil: AnvilConfig): DaemonConfig {
    const runConfig: AnvilConfig = {
        ...anvil,
        slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch,
        blockTimeSec: AnvilProcess.BlockTimeSec
      },
      daemonPath = DaemonConfig.daemonPath(config.dataPath, AnvilProcess.ProcessLabel)
    return {
      kind: DaemonKind.anvil,
      label: AnvilProcess.ProcessLabel,
      daemonPath,
      exe: anvil.binary,
      exeCommandName: AnvilProcess.ProcessLabel,
      exeEnvironmentVariable: AnvilBinEnvironmentVariable,
      argv: AnvilProcess.buildArgs(runConfig),
      conditions:
        runConfig.stateFile == null
          ? []
          : [
              {
                // At CREATE time this file does not exist, so a frozen script
                // would omit --load-state PERMANENTLY and restart anvil with no
                // deployed outpost contracts — surfacing as an OPP circulation
                // stall, never as a startup error.
                test: `[ -f "${quoteForTest(runConfig.stateFile, StartScriptVariable.CLUSTER_DIR, config.clusterPath)}" ]`,
                tokens: ["--load-state", runConfig.stateFile]
              }
            ],
      relocations: [{ prefix: daemonPath, variable: StartScriptVariable.NODE_DIR }]
    }
  }

  /** The local solana-test-validator — identical by construction to `run`'s (same runner). */
  function planSolanaValidator(config: ClusterConfig, validator: SolanaValidatorConfig): DaemonConfig {
    const daemonPath = DaemonConfig.daemonPath(config.dataPath, SolanaValidatorProcess.ProcessLabel)
    return {
      kind: DaemonKind.solanaValidator,
      label: SolanaValidatorProcess.ProcessLabel,
      daemonPath,
      exe: validator.binary,
      exeCommandName: SolanaValidatorProcess.ProcessLabel,
      exeEnvironmentVariable: SolanaValidatorBinEnvironmentVariable,
      argv: SolanaValidatorProcess.buildArgs(validator),
      // The UNCONDITIONAL default, never `resolveEnv()`: this value is frozen
      // into the emitted `start.sh` at CREATE time, and `resolveEnv` reads the
      // BUILD host's environment. Freezing its answer would either strip the
      // program-log target entirely (build host had RUST_LOG set) or pin one
      // the operator cannot override. The renderer emits it as a defaulting
      // expansion, so the run-time environment still wins.
      env: SolanaValidatorProcess.DefaultEnv,
      conditions: [],
      relocations: [{ prefix: daemonPath, variable: StartScriptVariable.NODE_DIR }]
    }
  }

  /**
   * The kiod wallet daemon. NO `$NODE_DIR` relocation: its argv addresses
   * `<cluster>/wallet` exclusively (wallet-dir / data-dir / config-dir all point
   * there, and it runs with that as `cwd`), while its `data/kiod/` directory
   * holds only the pidfile and log.
   */
  function planKiod(config: ClusterConfig, kiod: KiodConfig): DaemonConfig {
    return {
      kind: DaemonKind.kiod,
      label: KiodProcess.ProcessLabel,
      daemonPath: DaemonConfig.daemonPath(config.dataPath, KiodProcess.ProcessLabel),
      exe: kiod.binary,
      argv: KiodProcess.buildArgs(kiod),
      conditions: [],
      relocations: []
    }
  }

  /**
   * The bundled debugging server. NOT a `ManagedProcess` — it runs in-process
   * inside the harness, with no label, pidfile or spawned argv — so its
   * directory and command are DECLARED here rather than derived.
   */
  function planDebuggingServer(config: ClusterConfig, server: BindConfigDaemon): DaemonConfig {
    const daemonPath = Path.join(config.dataPath, DebuggingServerSubpath)
    return {
      kind: DaemonKind.debuggingServer,
      label: DebuggingServerSubpath,
      daemonPath,
      exe: NodeExecutable,
      exeCommandName: NodeExecutable,
      exeEnvironmentVariable: NodeBinEnvironmentVariable,
      argv: [
        Path.join(daemonPath, DebuggingServerBundleFilename),
        DebuggingServerStartCommand,
        "--cluster-path",
        config.clusterPath,
        "--host",
        server.address,
        "--port",
        String(server.port)
      ],
      conditions: [],
      relocations: [{ prefix: daemonPath, variable: StartScriptVariable.NODE_DIR }]
    }
  }

  /**
   * A path rendered for use INSIDE a shell test — the relocated form without
   * the outer quoting `toRelocatableToken` adds, since the test supplies its
   * own quotes.
   *
   * @param path - Absolute path on the build host.
   * @param variable - The variable its root maps to.
   * @param prefix - That root's prefix.
   * @returns The path with its root replaced by a `$VAR` expansion.
   */
  function quoteForTest(path: string, variable: StartScriptVariable, prefix: string): string {
    return matchesPrefix(path, prefix) ? `$${variable}${path.slice(prefix.length)}` : path
  }

  /** Directory (under the cluster data dir) the bundled debugging server lives in. */
  export const DebuggingServerSubpath = "debugging_server"

  /**
   * The directory a {@link ManagedProcess} label maps to — mirrors
   * `ManagedProcess.pidFile`'s derivation so the script lands beside the pidfile
   * rather than in an invented sibling.
   *
   * @param dataPath - The cluster data dir.
   * @param label - The process label.
   * @returns The daemon's directory.
   */
  export function daemonPath(dataPath: string, label: string): string {
    return Path.join(dataPath, label.replaceAll("-", "_"))
  }

  /**
   * The start script's path for a daemon directory.
   *
   * @param daemonPath - The daemon's directory.
   * @returns Absolute path of its `start.sh`.
   */
  export function startScriptFile(daemonPath: string): string {
    return Path.join(daemonPath, StartScriptFilename)
  }

  /**
   * Every `start.sh` anywhere under a cluster's data dir, whether or not the
   * current model still plans that daemon. Rebind uses this to DELETE before it
   * re-renders: `Clone` copies the local tree wholesale (it excludes only
   * `logs`/`reports`/`*.pid`), so a daemon the external model drops — anvil and
   * the validator under external-outpost mode — would otherwise keep its
   * LOCAL-port script, and the Verify scan cannot catch a file it never
   * enumerates.
   *
   * @param dataPath - The cluster data dir to sweep.
   * @param existsSync - Directory-existence probe (injected for testability).
   * @param readdirSync - Directory listing (injected for testability).
   * @returns Absolute paths of every `start.sh` found, one directory deep.
   */
  export function existingStartScriptFiles(
    dataPath: string,
    existsSync: (path: string) => boolean,
    readdirSync: (path: string) => string[]
  ): string[] {
    if (!existsSync(dataPath)) return []
    return readdirSync(dataPath)
      .map(entry => startScriptFile(Path.join(dataPath, entry)))
      .filter(file => existsSync(file))
  }

  /**
   * The cluster-wide relocation table — the roots every daemon's argv may
   * reference. `nodePath` is NOT here: it is per-daemon and must out-rank
   * `clusterPath`, so it rides {@link DaemonConfig.relocations}.
   *
   * @param config - The resolved cluster config.
   * @returns Prefix→variable mappings (unordered; the renderer orders them).
   */
  export function clusterRelocations(config: ClusterConfig): StartScriptRelocation[] {
    return [
      { prefix: config.clusterPath, variable: StartScriptVariable.CLUSTER_DIR },
      {
        prefix: config.buildPath,
        variable: StartScriptVariable.WIRE_PREFIX_PATH
      },
      {
        prefix: config.ethereumPath,
        variable: StartScriptVariable.WIRE_ETH_PATH
      },
      {
        prefix: config.solanaPath,
        variable: StartScriptVariable.WIRE_SOLANA_PATH
      }
    ]
  }
}
