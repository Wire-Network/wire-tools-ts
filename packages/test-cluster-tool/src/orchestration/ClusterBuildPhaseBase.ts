import type { Report } from "../report/Report.js"
import type { ClusterBuildContext } from "./ClusterBuildContext.js"

/**
 * Anything a phase or phase-group registers onto: the {@link ClusterBuild} root
 * or an enclosing {@link ClusterBuildPhaseGroup}. It carries the build context
 * (which the child adopts) and accepts children.
 */
export interface ClusterBuildParent<C extends ClusterBuildContext = ClusterBuildContext> {
  readonly context: C
  push(...children: ClusterBuildPhaseBase<C>[]): this
}

/**
 * Shared base for a {@link ClusterBuildPhase} (a group of steps) and a
 * {@link ClusterBuildPhaseGroup} (a group of phases / sub-groups). Both are
 * named, carry the build {@link ClusterBuildContext}, and execute to a **flat**
 * list of {@link Report.Phase} results — a phase yields its one phase, a group
 * yields its children's phases in run order.
 */
export abstract class ClusterBuildPhaseBase<
  C extends ClusterBuildContext = ClusterBuildContext
> {
  protected constructor(
    readonly context: C,
    readonly name: string,
    readonly description: string
  ) {}

  /**
   * Execute under `signal`, returning the flat list of {@link Report.Phase}s
   * produced. Never rejects — failures are captured into the report. A parent
   * aborts `signal` to cancel in-flight work (parallel groups) or to omit
   * not-yet-started children (sequential groups handle omission themselves).
   */
  abstract run(signal: AbortSignal): Promise<Report.Phase[]>
}
