import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import {
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { PidSources, pidIsAlive, readPid } from "@wireio/debugging-shared"
import { ProtocolTiming } from "../Constants.js"
import { BindConfigProvider } from "../config/BindConfigProvider.js"
import { SSMClientProvider } from "../config/SSMClientProvider.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../config/NodeConfig.js"
import { getLogger } from "../logging/Logger.js"
import type { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterBuildDefaults } from "../orchestration/ClusterBuildDefaults.js"
import { ClusterBuildPhase } from "../orchestration/ClusterBuildPhase.js"
import { Steps } from "../orchestration/steps/index.js"
import { pollUntil } from "../orchestration/StepTools.js"
import { Report } from "../report/Report.js"
import { OperatorDaemonTool } from "../tools/wire/OperatorDaemonTool.js"
import { eachSeries } from "../utils/asyncUtils.js"
import { mkdirs } from "../utils/fsUtils.js"
import { toDialAddress, toURL } from "../utils/netUtils.js"
import { ClusterState } from "./ClusterState.js"
import { AnvilProcess } from "./processes/AnvilProcess.js"
import { NodeopProcess } from "./processes/NodeopProcess.js"
import { ProcessManager } from "./processes/ProcessManager.js"

const log = getLogger(__filename)

/**
 * Slim cluster lifecycle: resolve config → lay down the filesystem (dirs, the
 * shared `genesis.json`, per-node `config.ini` / `logging.json`) → run the
 * {@link ClusterBuildDefaults} bootstrap → persist `cluster-config.json` +
 * `cluster-state.json` / `cluster-keys.json`. The heavy orchestration lives in
 * the build; this owns the filesystem, the process-manager cluster path,
 * teardown, and — via {@link run} — the direct relaunch of an
 * already-created cluster from its persisted state.
 */
export namespace ClusterManager {
  /** Per-node nodeop config filename. */
  const NodeConfigFilename = "config.ini"
  /** Per-node nodeop logging config filename. */
  const NodeLoggingFilename = "logging.json"

  /**
   * Epoch-advance liveness budget as a count of effective-epoch windows. At the
   * default 60s epoch this is 3 × (60 + 30)s = 270s — ≥ the ~4min a *resumed*
   * cluster can need to restart OPP circulation before `current_epoch_index`
   * advances. A healthy cluster still passes in ~1 epoch (the poll returns the
   * moment the index moves), so the larger ceiling adds no wall clock to a
   * healthy run — it only keeps a slow restart from failing a live cluster.
   */
  export const EpochVerifyEpochCount = 3
  /** Poll gap for the epoch-advance liveness verify (ms). */
  export const EpochVerifyPollIntervalMs = 1_000
  /** Local ms-per-second conversion (each flow's own `ScenarioConstants` carries the same literal). */
  export const MsPerSecond = 1_000

  /**
   * Create + bootstrap a cluster: resolve `options`, write the cluster files,
   * run the default build (plus a final persist phase writing
   * `cluster-state.json` + `cluster-keys.json`), persist the resolved config,
   * and return its {@link Report}. The process manager's cluster path is set
   * here so every `Steps.processes.*` step can get-or-create against it.
   */
  export async function create(options: ClusterBuildOptions): Promise<Report> {
    // The cluster path must be absent, or `--force` must authorize replacing
    // it — enforced BEFORE anything is resolved, bound, or written.
    prepareClusterPath(options)
    // SSM mode: the key-publication phases are composed INSIDE the default
    // build (`PublishNodeSignatureProviderKeys` after WalletAndKeys,
    // `PublishOperatorSignatureProviderKeys` after operator provisioning) —
    // each source's keys must be in SSM BEFORE their consumer nodeops start
    // and fetch them. Absent entirely under KEY.
    const build = await ClusterBuildDefaults.create(options)
    ClusterBuildPhase.create(
      build,
      "PersistClusterState",
      "Persist cluster-state.json + cluster-keys.json"
    ).push(
      Steps.clusterState.planPersist(
        Report.Actor.Sysio,
        "persist-cluster-state",
        "persist cluster-state.json + cluster-keys.json",
        {}
      )
    )
    return launch(build)
  }

  /**
   * Enforce {@link create}'s cluster-path precondition: the path is ABSENT, or
   * `--force` authorizes replacing it. An existing path without `--force` is a
   * hard error — never a silent overlay, which would inherit the previous
   * cluster's block logs, chain state and stale pidfiles under a freshly
   * written `genesis.json` and `cluster-config.json`.
   *
   * With `--force` the directory is removed outright — but never while its
   * daemons are still LIVE: deleting a running cluster's directory orphans its
   * nodeop / kiod / anvil / solana-test-validator processes, which keep holding
   * their ports and then collide with the new cluster's port resolution — a
   * failure whose symptom (an unrelated port claim failing much later) points
   * nowhere near here.
   *
   * @param options - The create options — `clusterPath` names the directory,
   *   `force` authorizes replacing it when it already exists.
   * @throws If the path exists without `force`, or if any pidfile under the
   *   existing cluster's `data/` names a live pid.
   */
  export function prepareClusterPath(options: ClusterBuildOptions): void {
    const { force, clusterPath } = options
    if (!Fs.existsSync(clusterPath)) return
    Assert.ok(
      force,
      `cluster directory already exists at ${clusterPath} — pass --force to replace it`
    )
    assertNoLivePids(
      clusterPath,
      Path.join(clusterPath, ClusterConfigProvider.DataSubpath)
    )
    Fs.rmSync(clusterPath, { recursive: true, force: true })
    log.info(
      `[cluster] force: removed pre-existing cluster path ${clusterPath}`
    )
  }

  /**
   * Lay down the filesystem + persist config for an ALREADY-COMPOSED build, run
   * it → {@link Report}, then STOP every daemon it started. Shared by {@link
   * create} (default bootstrap only) and `FlowCLI` (default bootstrap + the
   * flow's scenario phases already pushed onto `build`). The process-manager
   * cluster path is set here so every `Steps.processes.*` step can get-or-create
   * against it.
   *
   * `launch` owns the whole daemon lifecycle it starts — start, run, stop. Both
   * callers `process.exit()` the moment they have the Report, so the stop has to
   * happen here, BEFORE that exit, while the event loop can still drain child
   * stdio (see {@link stopDaemonsWhileDraining} for what deadlocks otherwise).
   * The Report is produced before the stop, so a stop failure can never mask it.
   *
   * @param build - The composed cluster build (bootstrap ± scenario phases).
   * @returns The run's report.
   */
  export async function launch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(build: ClusterBuild<C>): Promise<Report> {
    const config = build.config
    ProcessManager.setClusterPath(config.clusterPath)
    writeClusterFiles(config)
    await ClusterConfigProvider.save(config)
    log.info(
      `[cluster] filesystem ready at ${config.clusterPath}; running build`
    )
    // `finally`, not a trailing await: a build that REJECTS — an unexpected
    // orchestration error, a `Report.write()` filesystem failure — would
    // otherwise skip the stop and fall back to the synchronous exit sweep,
    // which is exactly the deadlock/data-loss path this stop exists to avoid.
    // The failure path is the one that can least afford a corrupted cluster,
    // since it is the one an operator will re-run from.
    try {
      return await build.build()
    } finally {
      // Never throws (it logs and defers to the exit sweep), so it cannot
      // replace an in-flight rejection with its own.
      await stopDaemonsWhileDraining()
    }
  }

  /**
   * Stop every managed daemon HERE, while the event loop is still running —
   * never by falling through to `process.exit()` and letting the exit-handler
   * sweep do it.
   *
   * `terminatePidsSync` (the sweep) is synchronous by necessity: it runs from
   * `process.on("exit")`, where queued async work never resumes. That means the
   * event loop is stopped for its whole duration — and a stopped event loop
   * stops draining the children's stdio sockets. nodeop logs heavily through
   * its own shutdown, so its stderr socket buffer fills, spdlog's console sink
   * blocks in `write(2)` WHILE HOLDING its global `console_mutex`, and every
   * other thread that logs piles up behind that mutex. The process deadlocks
   * before it can flush `blocks.log`, and the sweep eventually SIGKILLs it —
   * which truncates the block log, so the next `wire-cluster-tool run`
   * hard-replays, discards the unreadable tail, and silently loses every block
   * after it (including the bootstrap's `schbatchgps` + `bootstrap-epoch`).
   *
   * Confirmed by gdb on a wedged 24-node cluster: one `net-*` thread in
   * `__libc_write(fd=2)` under `ansicolor_sink<console_mutex>::log`, the rest in
   * `futex_wait` on `spdlog::details::console_mutex`, with `ShdPnd = 0` (the
   * SIGINT was delivered AND consumed — this is not a signalling problem). No
   * sweep budget can fix it: it is a deadlock, not slowness.
   *
   * Stopping from here keeps the loop alive, so the pipes drain and the daemons
   * exit on their own. The exit-handler sweep stays as the crash-path backstop.
   */
  async function stopDaemonsWhileDraining(): Promise<void> {
    log.info("[cluster] stopping daemons (event loop live — stdio draining)")
    try {
      await ProcessManager.get().stopAll()
    } catch (error) {
      // Never mask the Report: a stop failure leaves the exit sweep to finish.
      log.warn(
        `[cluster] graceful daemon stop failed; exit sweep will finish it: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /** Write dirs, the shared genesis, and per-node config/logging from the plan. */
  function writeClusterFiles(config: ClusterConfig): void {
    mkdirs(config.dataPath)
    mkdirs(config.walletPath)
    mkdirs(config.report.path)
    Fs.writeFileSync(
      ClusterConfigProvider.genesisFile(config),
      ClusterConfigProvider.genesisRenderer(config).render()
    )
    NodeConfig.plan(config).forEach(node => {
      mkdirs(node.nodePath)
      Fs.writeFileSync(
        Path.join(node.nodePath, NodeConfigFilename),
        node.ini.render()
      )
      Fs.writeFileSync(
        Path.join(node.nodePath, NodeLoggingFilename),
        node.logging.render()
      )
    })
  }

  /**
   * Scan every pidfile under every subdirectory of `dataPath` and throw, naming
   * every pid that is still alive. Pid parsing + the kernel probe ride
   * debugging-shared's {@link readPid} / {@link pidIsAlive} — the same
   * primitives the debugging surface monitors with. The ONE implementation
   * behind both live-cluster gates: {@link assertClusterStopped} (relaunch) and
   * {@link prepareClusterPath} (`create --force`), which has only the
   * caller's paths — never a resolved `ClusterConfig`.
   *
   * @param clusterPath - The cluster root, named in the failure message.
   * @param dataPath - The cluster's data dir holding the per-daemon pidfiles.
   * @throws If any pidfile under `dataPath` names a live pid.
   */
  function assertNoLivePids(
    clusterPath: ClusterConfig["clusterPath"],
    dataPath: ClusterConfig["dataPath"]
  ): void {
    if (!Fs.existsSync(dataPath)) return
    const livePids = Fs.readdirSync(dataPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const directory = Path.join(dataPath, entry.name)
        return Fs.readdirSync(directory)
          .filter(name => name.endsWith(PidSources.PidExt))
          .map(name => Path.join(directory, name))
      })
      .map(pidFile => readPid(pidFile))
      .filter(pid => pidIsAlive(pid))
    Assert.ok(
      livePids.length === 0,
      `cluster at ${clusterPath} appears to be running (live pid(s): ${livePids.join(", ")}) — stop it first`
    )
  }

  /**
   * Refuse to relaunch a still-live cluster — delegates the pidfile scan to
   * {@link assertNoLivePids}. Called at the top of {@link run}, before anything
   * is started or swept.
   *
   * @param config - The cluster config to check.
   * @throws If any pidfile under `config.dataPath` names a live pid.
   */
  export function assertClusterStopped(config: ClusterConfig): void {
    assertNoLivePids(config.clusterPath, config.dataPath)
  }

  /**
   * Start (or no-op if already running) `node`'s nodeop in RELAUNCH mode — the
   * shared body for bios / producer / operator nodes in {@link run}. Mirrors
   * `NodeopProcessSteps.runStart`'s option assembly exactly (same
   * `resolveOperator` / `resolveOperatorDaemonArgs` resolution), with
   * `relaunch: true` so the one-shot genesis flags are stripped.
   */
  async function startNode(
    ctx: ClusterBuildContext,
    node: NodeConfig
  ): Promise<void> {
    if (ctx.processManager.get(node.name) != null) return
    const operator = Steps.processes.nodeop.resolveOperator(ctx, node)
    await NodeopProcess.startWithRecovery(ctx.processManager, {
      node,
      operator,
      extraArgs: Steps.processes.nodeop.resolveOperatorDaemonArgs(
        ctx,
        node,
        operator
      ),
      relaunch: true
    })
  }

  /**
   * Start an existing cluster from saved state. Resolves once every daemon is
   * up and the epoch is confirmed advancing; daemons keep running until the
   * process exits (Ctrl+C → `ProcessManager`'s SIGINT teardown). Produces NO
   * `Report` — a plain launcher; the cluster's own logs under
   * `<cluster-path>/logs/` are the observable surface. Supports only clusters
   * produced by `wire-cluster-tool create` — flow-run clusters are ephemeral
   * and never persist `cluster-state.json` / `cluster-keys.json`.
   *
   * @param config - The loaded `cluster-config.json`.
   * @throws If the cluster is still running, ports have been reclaimed since
   *   resolve, or the post-start liveness checks (production resume, epoch
   *   advance) fail.
   */
  export async function run(config: ClusterConfig): Promise<void> {
    ProcessManager.setClusterPath(config.clusterPath)
    assertClusterStopped(config)
    ProcessManager.get().initialize()

    // Only the key material is reloaded — topology is RE-DERIVED from
    // NodeConfig.plan(config), the exact deterministic call `create`'s steps
    // make, so `run` and `create` can never drift apart.
    const keys = ClusterState.loadKeys(config)
    const ctx = new ClusterBuildContext(
      config,
      getLogger(config.report.basename)
    )
    ClusterState.rehydrate(ctx.keyStore, keys)

    // External-outpost mode (`config.externalOutposts`): the ETH + SOL outposts
    // run on real chains, so `run` skips the local anvil/validator starts and
    // publishes the daemon artifacts from the config; the head-advance gate
    // (not the epoch-distribution gate) is the success condition.
    const isExternalOutpost = config.externalOutposts != null

    Assert.ok(
      await BindConfigProvider.validate(config.bind),
      `cluster ${config.clusterPath}: one or more resolved ports are no longer free — cannot relaunch`
    )
    BindConfigProvider.registerResolved(config.bind)

    const controller = new AbortController(),
      nodes = NodeConfig.plan(config),
      biosNode = nodes.find(node => node.role === NodeRole.bios),
      producerNodes = nodes.filter(node => node.role === NodeRole.producer),
      operatorNodes = nodes.filter(node => node.role === NodeRole.operator)
    Assert.ok(biosNode != null, "run: bios node missing from NodeConfig.plan")

    log.info("[cluster] starting kiod")
    await Steps.processes.kiod.runStart(ctx, null, controller.signal)

    log.info("[cluster] unlocking wallet")
    await ctx.wire.wallet.unlock()

    log.info("[cluster] starting bios node")
    await startNode(ctx, biosNode)

    log.info(`[cluster] starting ${producerNodes.length} producer node(s)`)
    await Promise.all(producerNodes.map(node => startNode(ctx, node)))

    log.info("[cluster] resuming production")
    await eachSeries([biosNode, ...producerNodes], node =>
      NodeopProcess.resumeProduction(
        toURL(node.ports.http, toDialAddress(ctx.config.bind.nodeop.address))
      )
    )
    // Shared head-advance liveness (create's external gate + run use one impl).
    await Steps.externalOutpost.runHeadBlockAdvance(ctx, controller.signal)
    log.info("[cluster] production resumed; head advancing")

    if (isExternalOutpost) {
      log.info(
        "[cluster] external-outpost mode — skipping local anvil + solana-test-validator"
      )
    } else {
      log.info("[cluster] starting anvil")
      if (ctx.processManager.get(AnvilProcess.ProcessLabel) == null) {
        // Interval mining from the FIRST boot (constructor option, not the
        // create-path's post-deploy `evm_setIntervalMining` RPC toggle) — a
        // relaunch never runs the outpost deploy that needs instamine.
        const anvil = await AnvilProcess.create(ctx.processManager, {
          host: config.bind.anvil.address,
          port: config.bind.anvil.port,
          chainId: AnvilProcess.DefaultChainId,
          stateFile: Path.join(
            config.dataPath,
            AnvilProcess.StateSubpath,
            AnvilProcess.StateFilename
          ),
          slotsInAnEpoch: AnvilProcess.SlotsInAnEpoch,
          blockTimeSec: AnvilProcess.BlockTimeSec
        })
        await anvil.start()
      }

      log.info("[cluster] starting solana-test-validator")
      await Steps.processes.solanaValidator.runStart(ctx, null, controller.signal)
    }

    if (config.debuggingServerEnabled !== false) {
      log.info("[cluster] starting debugging server")
      await Steps.processes.debuggingServer.runStart(ctx, null, controller.signal)
    } else {
      log.info("[cluster] debugging server disabled — skipping (debuggingServerEnabled=false)")
    }

    log.info("[cluster] preparing operator daemon artifacts")
    await (isExternalOutpost
      ? Steps.externalOutpost.runPublishArtifacts(ctx, null, controller.signal)
      : OperatorDaemonTool.runArtifactPreparation(ctx, null, controller.signal))

    log.info(`[cluster] starting ${operatorNodes.length} operator node(s)`)
    await Promise.all(operatorNodes.map(node => startNode(ctx, node)))

    if (isExternalOutpost) {
      log.info(
        "[cluster] external-outpost mode — head advancing; skipping the epoch-advance gate"
      )
      return
    }

    log.info("[cluster] verifying epoch-advance liveness")
    const { rows: startRows } = await ctx.wire.getEpochState(),
      startEpochIndex = startRows[0]?.current_epoch_index ?? 0,
      budgetMs =
        EpochVerifyEpochCount *
        ProtocolTiming.effectiveEpochSec(config.epochDurationSec) *
        MsPerSecond
    try {
      await pollUntil(
        `sysio.epoch current_epoch_index advances past ${startEpochIndex}`,
        async () => {
          try {
            const { rows } = await ctx.wire.getEpochState()
            return (rows[0]?.current_epoch_index ?? 0) > startEpochIndex
          } catch (error) {
            log.debug(
              `[cluster] epoch-state read transient: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
          }
        },
        budgetMs,
        EpochVerifyPollIntervalMs
      )
    } catch (error) {
      log.error(
        `[cluster] epoch-advance liveness check failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
    log.info("[cluster] epoch-advance liveness confirmed — cluster is live")
  }

  /** Stop every managed process (graceful, or force-kill when `forceKill`). */
  export async function stop(forceKill = false): Promise<void> {
    await ProcessManager.get().stopAll(forceKill)
  }

  /**
   * Stop everything + remove the cluster directory. In the usual CLI case this
   * runs in a fresh process whose registry is empty — the pidfile orphan sweep
   * from `initialize()` is what terminates a still-live cluster's daemons.
   */
  export async function destroy(config: ClusterConfig): Promise<void> {
    ProcessManager.setClusterPath(config.clusterPath)
    ProcessManager.get().initialize()
    await stop(true)
    if (config.signatureProvider.type === SignatureProviderType.SSM) {
      await cleanupSignatureProviderKeys(config)
    }
    Fs.rmSync(config.clusterPath, { recursive: true, force: true })
  }

  /**
   * Best-effort delete of every published SSM parameter — ids re-rendered
   * deterministically from the persisted pattern × accounts × key types (guard +
   * log per the never-swallow rule; NEVER blocks destroy).
   *
   * @param config - The cluster config (SSM signature provider).
   */
  async function cleanupSignatureProviderKeys(
    config: ClusterConfig
  ): Promise<void> {
    const region = config.signatureProvider.ssm?.awsRegion
    if (region == null) return
    await eachSeries(
      Steps.keys.signatureProviderKeyPublications(config),
      async publication => {
        try {
          await SSMClientProvider.deleteParameter(region, publication.secretId)
        } catch (error) {
          log.warn(
            `[cluster] destroy: SSM DeleteParameter ${publication.secretId} failed (best-effort): ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    )
  }
}
