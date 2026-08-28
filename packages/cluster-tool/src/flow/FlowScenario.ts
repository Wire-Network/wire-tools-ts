import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import type { ArgumentsCamelCase, Argv } from "yargs"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"

import type { Logger } from "../logging/Logger.js"
import type { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"

/**
 * A `flow-*` scenario — the definition of one E2E flow, run by {@link FlowCLI}
 * on top of the {@link ClusterBuildDefaults} bootstrap. The class IS the
 * definition: it carries the flow `name` / `description` / option `defaults`, an
 * optional {@link createContext} factory (its own `ClusterBuildContext` subclass),
 * and a single {@link plan} that registers the scenario phases via
 * `ClusterBuildPhase.create<C>(cluster, …)`.
 *
 * @typeParam C - The scenario's context type (a `ClusterBuildContext` subclass
 *   carrying flow query helpers + typed events, or the base context).
 */
export abstract class FlowScenario<
  C extends ClusterBuildContext = ClusterBuildContext,
  A extends FlowScenarioArguments = EmptyFlowScenarioArguments
> {
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
   * Add scenario-only CLI options after the shared cluster options.
   *
   * @param yargs - Shared strict flow CLI parser.
   * @returns Parser extended with scenario-only options.
   */
  configureArguments?(yargs: Argv): Argv

  /**
   * Convert parsed yargs values into the scenario's typed planning arguments.
   *
   * @param argv - Parsed shared and scenario-specific CLI values.
   * @returns Typed arguments consumed by {@link plan}.
   */
  parseArguments?(argv: ArgumentsCamelCase): A

  /**
   * Register the scenario's phases onto the (bootstrap-loaded) `cluster` via
   * `ClusterBuildPhase.create<C>(cluster, …).push(…steps)`.
   *
   * @param cluster - The cluster build, pre-loaded with the bootstrap phases.
   * @param args - Typed scenario-only planning arguments.
   */
  abstract plan(cluster: ClusterBuild<C>, args: A): void
}

/** Marker shape for scenario-specific planning arguments. */
export interface FlowScenarioArguments {}

/** Empty argument shape used by flows with no scenario-only CLI options. */
export type EmptyFlowScenarioArguments = Record<string, never>

/** A zero-arg scenario constructor (`FlowCLI.create` instantiates the class). */
export type FlowScenarioConstructor<
  S extends FlowScenario<ClusterBuildContext, FlowScenarioArguments> =
    FlowScenario<ClusterBuildContext, FlowScenarioArguments>
> = new () => S

/** Extract a scenario's context type, so `FlowCLI.create(SomeScenario)` infers `FlowCLI<ItsContext>`. */
export type FlowScenarioContextOf<
  S extends FlowScenario<ClusterBuildContext, FlowScenarioArguments>
> = S extends FlowScenario<infer C, FlowScenarioArguments> ? C : never

/** Extract a scenario's typed planning-argument shape. */
export type FlowScenarioArgumentsOf<
  S extends FlowScenario<ClusterBuildContext, FlowScenarioArguments>
> = S extends FlowScenario<ClusterBuildContext, infer A> ? A : never
