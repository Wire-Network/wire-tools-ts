import Bluebird from "bluebird"
import { defaults } from "lodash"
import { match } from "ts-pattern"
import type { Report } from "../report/Report.js"
import type { ClusterBuildContext } from "./ClusterBuildContext.js"
import {
  ClusterBuildPhaseBase,
  type ClusterBuildParent
} from "./ClusterBuildPhaseBase.js"

/** Caller tuning for a {@link ClusterBuildPhaseGroup}. */
export interface ClusterBuildPhaseGroupOptions {
  /** Run children concurrently instead of in series. Defaults to `false`. */
  parallel?: boolean
}

/** Resolved {@link ClusterBuildPhaseGroup} config. */
export type ClusterBuildPhaseGroupConfig = Required<ClusterBuildPhaseGroupOptions>

/**
 * A nestable grouping of phases and/or sub-groups. Built by the
 * {@link ClusterBuildPhaseGroup.create} factory (never `new`); it self-registers
 * on its {@link ClusterBuildParent} and is itself a parent (phases/groups register
 * onto it). Executes its children **sequentially by default** (`config.parallel
 * === false`) — the first failing child short-circuits the rest — or concurrently
 * when `parallel`, where the first failure aborts the shared signal so in-flight
 * siblings cancel cooperatively. Children's `Report.Phase`s flatten into the
 * report in run order.
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
   * Run children per {@link config}, returning their flattened
   * {@link Report.Phase}s. Sequential: stop at the first failed child (the rest
   * are omitted). Parallel: a failing child aborts the shared controller so
   * in-flight siblings cancel; all produced phases are collected.
   */
  async run(signal: AbortSignal): Promise<Report.Phase[]> {
    const controller = new AbortController(),
      onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
    try {
      return await match(this.config.parallel)
        .with(true, async () => {
          const results = await Promise.all(
            this.childList.map(async child => {
              const phases = await child.run(controller.signal)
              if (phases.some(phase => !phase.succeeded)) controller.abort()
              return phases
            })
          )
          return results.flat()
        })
        .with(false, async () => {
          const phases: Report.Phase[] = []
          await Bluebird.each(this.childList, async child => {
            if (controller.signal.aborted) {
              this.context.log.info(
                `↷ Abort signalled by an earlier failure — "${child.name}" will not be executed (omitted)`
              )
              return
            }
            const childPhases = await child.run(controller.signal)
            phases.push(...childPhases)
            if (childPhases.some(phase => !phase.succeeded)) controller.abort()
          })
          return phases
        })
        .exhaustive()
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

export namespace ClusterBuildPhaseGroup {
  /** Config defaults — groups run **sequentially** unless `parallel` is set. */
  export const ConfigDefaults: ClusterBuildPhaseGroupConfig = { parallel: false }
}
