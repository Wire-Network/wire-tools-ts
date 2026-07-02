import Bluebird from "bluebird"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfig } from "../config/ClusterConfig.js"
import { getLogger, type Logger } from "../logging/Logger.js"
import { Report } from "../report/Report.js"
import { ReportRendererRegistry } from "../report/ReportRendererRegistry.js"
import { ClusterBuildContext } from "./ClusterBuildContext.js"
import {
  ClusterBuildPhaseBase,
  type ClusterBuildParent
} from "./ClusterBuildPhaseBase.js"

/**
 * The CDK-like engine + the phase-tree root. Phases and phase-groups self-register
 * through their `create()` factory onto this build (or onto an enclosing group);
 * {@link build} runs the top-level children as a sequential sequence, stopping at
 * the first failed phase, and emits the {@link Report}. The CLI `create` and every
 * `flow-*` run this identical engine — they differ only in which phases/groups were
 * registered.
 */
export class ClusterBuild<C extends ClusterBuildContext = ClusterBuildContext>
  implements ClusterBuildParent<C>
{
  private readonly childList: ClusterBuildPhaseBase<C>[] = []
  private readonly report = new Report()

  private constructor(readonly context: C) {}

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
   * Async factory — resolves options → {@link ClusterConfig}, builds the context
   * (the flow's `C` via `createContext`, default base), pre-registers `children`.
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
    const config = await ClusterConfig.resolve(options),
      log = getLogger(config.report.basename),
      context = createContext
        ? createContext(config, log)
        : (new ClusterBuildContext(config, log) as C)
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
   * deliverable either way.
   */
  async build(): Promise<Report> {
    const controller = new AbortController()
    await Bluebird.each(this.childList, async child => {
      if (controller.signal.aborted) {
        this.context.log.info(
          `↷ Abort signalled by an earlier failure — "${child.name}" will not be executed (omitted)`
        )
        return
      }
      const phases = await child.run(controller.signal)
      this.report.push(...phases)
      if (phases.some(phase => !phase.succeeded)) controller.abort()
    })
    await this.report.write(this.config.report, ReportRendererRegistry.createDefault())
    return this.report
  }
}
