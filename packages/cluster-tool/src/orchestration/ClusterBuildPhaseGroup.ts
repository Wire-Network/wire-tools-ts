import Bluebird from "bluebird"
import { defaults } from "lodash"
import { match } from "ts-pattern"
import { eachSeries } from "../utils/asyncUtils.js"
import { Report } from "../report/Report.js"
import type { ClusterBuildContext } from "./ClusterBuildContext.js"
import { ClusterBuildFailureMode } from "./ClusterBuildFailureMode.js"
import {
  ClusterBuildPhaseBase,
  type ClusterBuildParent
} from "./ClusterBuildPhaseBase.js"

/** Caller tuning for a {@link ClusterBuildPhaseGroup}. */
export interface ClusterBuildPhaseGroupOptions {
  /** Run children concurrently instead of in series. Defaults to `false`. */
  parallel?: boolean
  /**
   * Max children in flight when `parallel` — the Bluebird `map` concurrency.
   * Defaults to {@link ClusterBuildPhaseGroup.UnboundedConcurrency} (every child
   * at once, matching a bare `Promise.all`).
   *
   * Bound it when the children contend for a shared external resource that
   * degrades under a thundering herd rather than merely queueing — starting N
   * chain nodes is the motivating case: they all join one p2p mesh and sync
   * simultaneously, which starves the producers' vote propagation and can
   * freeze finality outright.
   */
  concurrency?: number
  /** Continue executing independent children after a failed child. */
  failureMode?: ClusterBuildFailureMode
}

/** Resolved {@link ClusterBuildPhaseGroup} config. */
export type ClusterBuildPhaseGroupConfig = Required<ClusterBuildPhaseGroupOptions>

/**
 * A nestable grouping of phases and/or sub-groups. Built by the
 * {@link ClusterBuildPhaseGroup.create} factory (never `new`); it self-registers
 * on its {@link ClusterBuildParent} and is itself a parent (phases/groups register
 * onto it). Executes its children **sequentially by default** (`config.parallel
 * === false`) or concurrently when `parallel`. Fail-fast mode aborts remaining
 * work after the first failed child; collect mode preserves every independent
 * child result. Children's `Report.Phase`s flatten into the report in run order.
 */
export class ClusterBuildPhaseGroup<
    C extends ClusterBuildContext = ClusterBuildContext
  >
  extends ClusterBuildPhaseBase<C>
  implements ClusterBuildParent<C>
{
  private readonly childList: ClusterBuildPhaseBase<C>[] = []
  readonly config: ClusterBuildPhaseGroupConfig

  private constructor(
    context: C,
    name: string,
    description: string,
    options: ClusterBuildPhaseGroupOptions
  ) {
    super(context, name, description)
    this.config = defaults(
      { ...options },
      ClusterBuildPhaseGroup.ConfigDefaults
    ) as ClusterBuildPhaseGroupConfig
  }

  /** Factory — self-registers on `parent` (the build root or an enclosing group). */
  static create<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildPhaseGroupOptions = {}
  ): ClusterBuildPhaseGroup<C> {
    const group = new ClusterBuildPhaseGroup<C>(parent.context, name, description, options)
    parent.push(group)
    return group
  }

  /** Externally read-only view of the registered children. */
  get children(): ReadonlyArray<ClusterBuildPhaseBase<C>> {
    return this.childList
  }

  /** Append child phases / groups (chainable). */
  push(...children: ClusterBuildPhaseBase<C>[]): this {
    this.childList.push(...children)
    return this
  }

  /**
   * Run children per {@link config} and return ONE {@link Report.Group} node
   * whose `children` nest the produced {@link Report.Node}s in run order.
   * Fail-fast mode omits/cancels remaining children after a failure. Collect
   * mode continues and retains every independent child result.
   */
  async run(signal: AbortSignal): Promise<Report.Node[]> {
    const startedAtMs = Date.now(),
      controller = new AbortController(),
      onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
    try {
      const children = await match(this.config.parallel)
        .with(true, async () => {
          const results = await Bluebird.map(
            this.childList,
            async child => {
              const nodes = await child.run(controller.signal)
              if (
                this.config.failureMode === ClusterBuildFailureMode.failFast &&
                nodes.some(node => !node.succeeded)
              ) {
                controller.abort()
              }
              return nodes
            },
            { concurrency: this.config.concurrency }
          )
          return results.flat()
        })
        .with(false, async () => {
          const nodes: Report.Node[] = []
          await eachSeries(this.childList, async child => {
            if (controller.signal.aborted) {
              this.context.log.info(
                `↷ Abort signalled by an earlier failure — "${child.name}" will not be executed (omitted)`
              )
              return
            }
            const childNodes = await child.run(controller.signal)
            nodes.push(...childNodes)
            if (
              this.config.failureMode === ClusterBuildFailureMode.failFast &&
              childNodes.some(node => !node.succeeded)
            ) {
              controller.abort()
            }
          })
          return nodes
        })
        .exhaustive()
      return [
        Report.Group.from(
          this.name,
          this.description,
          children,
          Date.now() - startedAtMs
        )
      ]
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

export namespace ClusterBuildPhaseGroup {
  /**
   * Every child in flight at once — the `concurrency` default, preserving the
   * `Promise.all` semantics parallel groups had before the option existed.
   */
  export const UnboundedConcurrency = Infinity

  /** Config defaults — groups run **sequentially** unless `parallel` is set. */
  export const ConfigDefaults: ClusterBuildPhaseGroupConfig = {
    parallel: false,
    concurrency: UnboundedConcurrency,
    failureMode: ClusterBuildFailureMode.failFast
  }
}
