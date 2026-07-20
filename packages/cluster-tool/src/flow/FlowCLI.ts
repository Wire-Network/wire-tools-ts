import Yargs, { type Argv } from "yargs"
import {
  applyClusterBuildOptionsArgs,
  mergeSignatureProviderSsm,
  toClusterBuildOptions
} from "../cli/ClusterBuildOptionsArgs.js"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { getLogger } from "../logging/Logger.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterBuildDefaults } from "../orchestration/ClusterBuildDefaults.js"
import type { Report } from "../report/Report.js"
import {
  FlowScenario,
  type FlowScenarioConstructor,
  type FlowScenarioContextOf
} from "./FlowScenario.js"

const log = getLogger(__filename)

/**
 * The runner for a `flow-*` executable — the SAME `cluster → phase → step →
 * Report` machine the `wire-cluster-tool create` command runs, wrapped by a thin
 * yargs entry. `FlowCLI.create(SomeScenario)` builds an instance (context
 * inferred from the scenario class); {@link run} parses argv, composes the
 * bootstrap + the scenario's phases, launches the cluster, and returns the
 * {@link Report}. A flow's `src/index.ts` is just
 * `process.exit((await FlowCLI.create(SomeScenario).run()).succeeded ? 0 : 1)`.
 *
 * @typeParam C - The scenario's context type (inferred via {@link FlowScenarioContextOf}).
 */
export class FlowCLI<C extends ClusterBuildContext = ClusterBuildContext> {
  /** The yargs surface (shared `ClusterBuildOptions` flags) — exposed for per-flow customization. */
  readonly yargs: Argv

  private constructor(private readonly scenario: FlowScenario<C>) {
    this.yargs = applyClusterBuildOptionsArgs(
      Yargs(process.argv.slice(2)),
      scenario.defaults
    )
      .scriptName(scenario.name)
      .usage(`$0 — ${scenario.description}`)
      .strict()
      .help()
  }

  /**
   * Build a `FlowCLI` from a scenario CLASS — an instance whose context type is
   * inferred from the scenario (no per-call-site generic argument).
   *
   * @param scenarioClass - The `FlowScenario` subclass (zero-arg constructor).
   * @returns The flow CLI, typed to the scenario's context.
   */
  static create<S extends FlowScenario, C extends FlowScenarioContextOf<S> = FlowScenarioContextOf<S>>(
    scenarioClass: FlowScenarioConstructor<FlowScenario<C>>
  ): FlowCLI<FlowScenarioContextOf<S>> {
    // `S extends FlowScenario<FlowScenarioContextOf<S>>` holds semantically, but the
    // `plan(cluster: ClusterBuild<C>)` param makes `FlowScenario<C>` contravariant
    // in `C`, so TS won't verify the narrowing — route through `unknown`.
    const scenario = new scenarioClass()
    
    return new FlowCLI<C>(scenario)
  }

  /**
   * Parse argv → options, compose the default bootstrap + the scenario's phases,
   * lay down the cluster + run it, and return the {@link Report}. The entrypoint
   * sets the process exit code from `report.succeeded`.
   *
   * @returns The run's report.
   */
  async run(): Promise<Report> {
    // Scenario defaults supply the non-flag leaves (collateral object-arrays)
    // that can't ride the argv surface.
    const argv = await this.yargs.parseAsync(),
      options = mergeSignatureProviderSsm(
        toClusterBuildOptions(argv, this.scenario.defaults),
        argv
      )
    const cluster = await ClusterBuildDefaults.create<C>(
      options,
      this.scenario.createContext?.bind(this.scenario)
    )
    this.scenario.plan(cluster)
    // Name the report before launch — the renderers title with it
    // ("flow-…: SUCCESS|FAILED") and launch writes the files.
    cluster.report.name = this.scenario.name
    const report = await ClusterManager.launch(cluster)
    log.info(
      `[${this.scenario.name}] ${report.succeeded ? "SUCCEEDED" : "FAILED"}`
    )
    return report
  }
}
