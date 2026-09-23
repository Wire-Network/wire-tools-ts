import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SlugName } from "@wireio/sdk-core"
import type { ArgumentsCamelCase, Argv } from "yargs"

import {
  FlowScenario,
  SwapCanaryConfig,
  SwapCanaryPhaseGroups,
  SwapRouteCatalog,
  SwapRouteSelector,
  SwapScenarioContext,
  Steps,
  type ClusterBuild,
  type ClusterBuildOptions,
  type FlowScenarioArguments,
  type Logger
} from "@wireio/cluster-tool"

/** Scenario-only CLI arguments. Selectors are unioned and de-duplicated. */
export interface SwapCanaryArguments extends FlowScenarioArguments {
  readonly routes: readonly SwapRouteSelector[]
  readonly waitForChallenge: boolean
}

/** Fresh-cluster FlowScenario over the shared swap-canary PhaseGroups. */
export class SwapCanaryScenario extends FlowScenario<
  SwapScenarioContext,
  SwapCanaryArguments
> {
  readonly name = "flow-swap-canary"
  readonly description =
    "Configurable canary for public ETH, SOL, and WIRE swap routes"

  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true,
    epochDurationSec: SwapCanaryConfig.EpochDurationSec,
    requiredUnderwriterCollateral: [
      {
        chainCode: SlugName.from("ETHEREUM"),
        tokenCode: SlugName.from("ETH"),
        minimumBond: SwapCanaryConfig.UnderwriterMinimumBond
      },
      {
        chainCode: SlugName.from("SOLANA"),
        tokenCode: SlugName.from("SOL"),
        minimumBond: SwapCanaryConfig.UnderwriterMinimumBond
      }
    ]
  }

  /** Add the repeatable route selector and optional challenge wait. */
  override configureArguments(yargs: Argv): Argv {
    return yargs
      .option("routes", {
        type: "string",
        array: true,
        choices: Object.values(SwapRouteSelector),
        default: [SwapRouteSelector.canary],
        description:
          "Route selector; repeat to union groups (default: one public reserve per endpoint)"
      })
      .option("wait-for-challenge", {
        type: "boolean",
        default: false,
        description: "Wait for each exact UWREQ to reach COMPLETED"
      })
  }

  /** Validate raw yargs into the scenario's small typed planning surface. */
  override parseArguments(argv: ArgumentsCamelCase): SwapCanaryArguments {
    const raw = Array.isArray(argv.routes)
      ? argv.routes.map(String)
      : [String(argv.routes ?? SwapRouteSelector.canary)]
    return {
      routes: SwapRouteCatalog.parseSelectors(raw),
      waitForChallenge: Boolean(argv.waitForChallenge)
    }
  }

  /** Create the shared swap query context. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  /** Compose the full fresh-cluster canary, including collateral provisioning. */
  override plan(
    cluster: ClusterBuild<SwapScenarioContext>,
    args: SwapCanaryArguments
  ): void {
    SwapCanaryPhaseGroups.plan(cluster, {
      ...args,
      availableRoutes: SwapRouteCatalog.fromReserveRegistrations(
        Steps.registry.MockReserveRegistrations
      ),
      provisionUnderwriterCollateral: true
    })
  }
}
