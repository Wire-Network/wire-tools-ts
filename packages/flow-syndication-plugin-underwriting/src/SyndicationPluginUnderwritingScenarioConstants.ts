import { BatchOperatorUnderwritingSteps } from "@wireio/cluster-tool"

/** The syndications, pair rules and typed cross-step state of the plugin-underwriting flow. */
export namespace SyndicationPluginUnderwritingScenarioConstants {
  /** The flow's syndications and recorded state, under the `pluginUnderwriting.` output keys. */
  export const Plan =
    BatchOperatorUnderwritingSteps.createPlan("pluginUnderwriting")
  /** Pair-specific governance rules at the default challenge window, set in setup and restored at the end. */
  export const Config = BatchOperatorUnderwritingSteps.configOf(Plan)
}
