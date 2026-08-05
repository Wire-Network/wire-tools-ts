import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { guard } from "@wireio/shared"
import { Constants } from "../Constants.js"
import { eachSeries } from "../utils/asyncUtils.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { NodeConfig } from "../config/NodeConfig.js"
import { getLogger, type Logger } from "../logging/Logger.js"
import { Report } from "../report/Report.js"
import { ReportRendererRegistry } from "../report/ReportRendererRegistry.js"
import { ClusterBuildContext } from "./ClusterBuildContext.js"
import {
  ClusterBuildPhaseBase,
  type ClusterBuildParent
} from "./ClusterBuildPhaseBase.js"

/**
 * Seed the key store with the two accounts whose key material exists BEFORE any
 * step runs — the bios node's genesis producer (`sysio`) and the bootstrap node
 * owner (`wireno`). Both are resolved at CONFIG time by
 * {@link ClusterConfigProvider.resolveWithBiosKeys} because `genesis.json` and
 * every `config.ini` are written before `build()` runs, and the first
 * `roa::newuser` signs as the node owner out of the kiod wallet.
 *
 * `setOperator`, NEVER `pushNodes`: `ConsensusSteps.runSetFinalizer` builds the
 * genesis finalizer policy from `keyStore.nodes` with `threshold = ⌊2n/3⌋ + 1`,
 * so a bios entry there would silently add a finalizer and shift consensus.
 *
 * Both entries carry {@link OperatorType.UNKNOWN}, NOT `PRODUCER`: neither
 * account is a registered OPP operator, and `ConsensusSteps.runSetProducerKeys`
 * builds the `setprodkeys` schedule from
 * `keyStore.operatorsByType(OperatorType.PRODUCER)` — a `PRODUCER`-typed entry
 * here would put `sysio` / `wireno` in the on-chain producer schedule. Nothing
 * that consumes these two entries (`NodeopProcessSteps.resolveOperator`,
 * `NodeopProcess.buildArgs`, the wallet import) reads `type`.
 */
function seedGenesisAccounts(
  context: ClusterBuildContext,
  resolved: ClusterConfigProvider.ClusterConfigWithBiosKeys
): void {
  context.keyStore
    .setOperator({
      // HANDLE is the bios NODE name — the segment its `--signature-provider`
      // spec renders and the segment its keys are published under. ACCOUNT is
      // the on-chain `sysio`. Keying this by the account was what put the
      // genesis identity out of reach of the publication walker.
      label: NodeConfig.BiosName,
      publicationLabel: NodeConfig.BiosName,
      account: NodeConfig.BiosProducer,
      type: OperatorType.UNKNOWN,
      wire: resolved.biosWire,
      wireFinalizer: resolved.biosFinalizer
    })
    .setOperator({
      label: Constants.BOOTSTRAP_NODE_OWNER,
      publicationLabel: Constants.BOOTSTRAP_NODE_OWNER,
      account: Constants.BOOTSTRAP_NODE_OWNER,
      type: OperatorType.UNKNOWN,
      wire: resolved.nodeOwnerWire
    })
}

/**
 * The CDK-like engine + the phase-tree root. Phases and phase-groups self-register
 * through their `create()` factory onto this build (or onto an enclosing group);
 * {@link build} runs the top-level children as a sequential sequence, stopping at
 * the first failed phase, and emits the {@link Report}. The CLI `create` and every
 * `flow-*` run this identical engine — they differ only in which phases/groups were
 * registered.
 */
export class ClusterBuild<
  C extends ClusterBuildContext = ClusterBuildContext
> implements ClusterBuildParent<C> {
  private readonly childList: ClusterBuildPhaseBase<C>[] = []
  private readonly reportInternal = new Report()

  private constructor(readonly context: C) {}

  /** The run's report — named by the flow (`report.name`) before launch. */
  get report(): Report {
    return this.reportInternal
  }

  /** The resolved cluster config (from the context). */
  get config(): ClusterConfig {
    return this.context.config
  }

  /**
   * Construct from an already-built context (the synchronous core; used by tests
   * and by `create` once config is resolved).
   *
   * @param context - The build's context.
   * @param children - Phases / groups to pre-register.
   */
  static forContext<C extends ClusterBuildContext = ClusterBuildContext>(
    context: C,
    children: ClusterBuildPhaseBase<C>[] = []
  ): ClusterBuild<C> {
    return new ClusterBuild<C>(context).push(...children)
  }

  /**
   * Async factory — resolves options → {@link ClusterConfig} **plus its
   * genesis-time key material** ({@link ClusterConfigProvider.resolveWithBiosKeys}
   * — the ONE consumer of that entry point), builds the context (the flow's `C`
   * via `createContext`, default base), seeds the bios + node-owner accounts
   * into its key store, and pre-registers `children`.
   *
   * @param options - Caller options.
   * @param children - Phases / groups to pre-register.
   * @param createContext - Optional flow-context factory.
   */
  static async create<C extends ClusterBuildContext = ClusterBuildContext>(
    options: ClusterBuildOptions = {},
    children: ClusterBuildPhaseBase<C>[] = [],
    createContext?: (config: ClusterConfig, log: Logger) => C
  ): Promise<ClusterBuild<C>> {
    const resolved = await ClusterConfigProvider.resolveWithBiosKeys(options),
      { config } = resolved,
      log = getLogger(config.report.basename),
      context = createContext
        ? createContext(config, log)
        : (new ClusterBuildContext(config, log) as C)
    seedGenesisAccounts(context, resolved)
    return ClusterBuild.forContext(context, children)
  }

  /** Externally read-only view of the registered top-level children. */
  get children(): ReadonlyArray<ClusterBuildPhaseBase<C>> {
    return this.childList
  }

  /** Register phases / groups (called by a child's `create()` factory + composers). */
  push(...children: ClusterBuildPhaseBase<C>[]): this {
    this.childList.push(...children)
    return this
  }

  /**
   * Compose other builds into this one — appends each additional build's children,
   * in order. The composition primitive (never named `apply`, which would collide
   * with `Function.apply`).
   */
  append(...additionalBuilds: ClusterBuild<C>[]): this {
    additionalBuilds.forEach(build => this.childList.push(...build.children))
    return this
  }

  /**
   * Run the top-level children in order (sequential); stop at the first failed
   * phase; render the report to every configured format. The Report is the
   * deliverable either way — INCLUDING when the run does not finish.
   *
   * An `exit` listener is armed for the whole run and disarmed only once the
   * async write below has SUCCEEDED, so every path that skips that write still
   * persists the narrative:
   *
   * - **Interrupt.** `ProcessManager`'s SIGINT/SIGTERM handlers call
   *   `process.exit`, so no async continuation ever resumes — a partial Report
   *   can only be written synchronously, from `exit`. A monitor that bails on a
   *   stalled epoch kills the run exactly this way, and the Report is the
   *   per-step record the diagnosis then needs.
   * - **An unexpected rejection out of a phase**, which propagates past the
   *   write on its way to `ClusterManager.launch`'s `finally`.
   * - **A failure of the async write itself** (a full disk mid-write).
   *
   * `guard` because throwing from an `exit` listener would replace the run's
   * real outcome with a write error nobody can act on.
   */
  async build(): Promise<Report> {
    const controller = new AbortController(),
      registry = ReportRendererRegistry.createDefault(),
      persistOnExit = () =>
        guard(() => this.interruptedReport().writeSync(this.config.report, registry))

    process.once("exit", persistOnExit)
    await eachSeries(this.childList, async child => {
      if (controller.signal.aborted) {
        this.context.log.info(
          `↷ Abort signalled by an earlier failure — "${child.name}" will not be executed (omitted)`
        )
        return
      }
      const phases = await child.run(controller.signal)
      this.reportInternal.push(...phases)
      if (phases.some(phase => !phase.succeeded)) controller.abort()
    })
    await this.reportInternal.write(this.config.report, registry)
    process.removeListener("exit", persistOnExit)
    return this.reportInternal
  }

  /**
   * The narrative to persist when the run never finished: every phase that
   * COMPLETED, flat and in completion order, flagged `interrupted` so the title
   * reads INTERRUPTED rather than a vacuous SUCCESS.
   *
   * Sourced from `context.completedPhases`, NOT `reportInternal` — the latter's
   * tree stays empty until a whole top-level child returns, so mid-group it
   * carries nothing (measured on a killed bootstrap: 106 steps completed, 0
   * nodes in the tree). The group nesting is the only thing lost; every phase
   * and every step result survives.
   */
  private interruptedReport(): Report {
    const report = new Report().push(...this.context.completedPhases)
    report.name = this.reportInternal.name
    report.interrupted = true
    return report
  }
}
