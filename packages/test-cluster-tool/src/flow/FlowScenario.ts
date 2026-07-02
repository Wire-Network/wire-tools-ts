import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import type { ClusterConfig } from "../config/ClusterConfig.js"
import type { Logger } from "../logging/Logger.js"
import type { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"

/**
 * A `flow-*` scenario — the definition of one E2E flow, run by {@link FlowCLI}
 * on top of the {@link ClusterBuildDefaults} bootstrap. The class IS the
 * definition: it carries the flow `name` / `description` / option `defaults`, an
 * optional {@link createContext} factory (its own `ClusterBuildContext` subclass),
 * and a single {@link build} that registers the scenario phases via
 * `ClusterBuildPhase.create<C>(cluster, …)`.
 *
 * @typeParam C - The scenario's context type (a `ClusterBuildContext` subclass
 *   carrying flow query helpers + typed events, or the base context).
 */
export abstract class FlowScenario<C extends ClusterBuildContext = ClusterBuildContext> {
  /** Flow identifier — used as the report basename + cluster label (`"flow-…"`). */
  abstract readonly name: string

  /** One-line description shown in CLI usage + the report header. */
  abstract readonly description: string

  /** Option defaults seeding the flow's CLI flags (epoch duration, collateral, …). */
  readonly defaults: ClusterBuildOptions = {}

  /**
   * Build the flow's context `C`. Omit for the base {@link ClusterBuildContext};
   * override to return a scenario subclass (flow query helpers + typed events).
   *
   * @param config - The resolved cluster config.
   * @param log - The run logger.
   * @returns The scenario context instance.
   */
  createContext?(config: ClusterConfig, log: Logger): C

  /**
   * Register the scenario's phases onto the (bootstrap-loaded) `cluster` via
   * `ClusterBuildPhase.create<C>(cluster, …).push(…steps)`.
   *
   * @param cluster - The cluster build, pre-loaded with the bootstrap phases.
   */
  abstract build(cluster: ClusterBuild<C>): void
}

/** A zero-arg scenario constructor (`FlowCLI.create` instantiates the class). */
export type FlowScenarioConstructor<S extends FlowScenario = FlowScenario> = new () => S

/** Extract a scenario's context type, so `FlowCLI.create(SomeScenario)` infers `FlowCLI<ItsContext>`. */
export type FlowScenarioContextOf<S extends FlowScenario> =
  S extends FlowScenario<infer C> ? C : never
