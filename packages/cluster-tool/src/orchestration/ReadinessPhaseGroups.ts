import { ClusterReadinessFeature } from "@wireio/cluster-tool-shared"

import { Report } from "../report/Report.js"
import type { ReadinessContext } from "../readiness/ReadinessContext.js"
import { ClusterBuildFailureMode } from "./ClusterBuildFailureMode.js"
import { ClusterBuildPhase } from "./ClusterBuildPhase.js"
import type { ClusterBuildParent } from "./ClusterBuildPhaseBase.js"
import { ClusterBuildPhaseGroup } from "./ClusterBuildPhaseGroup.js"
import { Steps } from "./steps/index.js"

/** Reusable readiness compositions for manual runs and future FlowScenarios. */
export namespace ReadinessPhaseGroups {
  /** Plan the selected read-only readiness suite under one collect-all group. */
  export function plan(
    parent: ClusterBuildParent<ReadinessContext>,
    feature: ClusterReadinessFeature
  ): ClusterBuildPhaseGroup<ReadinessContext> {
    const readiness = ClusterBuildPhaseGroup.create<ReadinessContext>(
      parent,
      `${feature}-readiness`,
      `Read-only cluster and ${feature} readiness evidence`,
      { failureMode: ClusterBuildFailureMode.collect }
    )

    planDiscovery(readiness)
    planClusterHealth(readiness)
    if (
      readiness.context.config.outpostDeploymentProfileRequested ||
      readiness.context.config.outpostDeploymentProfile
    ) {
      planOutpostDeployment(readiness)
    }
    if (feature === ClusterReadinessFeature.swap) {
      planWireConfiguration(readiness)
      planSwap(readiness)
    } else planStake(readiness)

    return readiness
  }
}

function planOutpostDeployment(
  parent: ClusterBuildParent<ReadinessContext>
): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "SDK-outpost compatibility",
    "Compare optional SDK artifacts with the Wire, Ethereum, and Solana deployment",
    [
      Steps.readiness.outpostDeployment.planWireDeploymentProfile(
        Report.Actor.Sysio,
        "wire-deployment-profile",
        "Verify the Wire chain bound to the deployment profile",
        {}
      ),
      Steps.readiness.outpostDeployment.planEthereumDeploymentProfile(
        Report.Actor.EthereumOutpost,
        "ethereum-deployment-profile",
        "Verify exact Ethereum proxy implementations and runtime code",
        {}
      ),
      Steps.readiness.outpostDeployment.planSolanaDeploymentProfile(
        Report.Actor.SolanaOutpost,
        "solana-deployment-profile",
        "Verify exact Solana ProgramData identity",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planDiscovery(parent: ClusterBuildParent<ReadinessContext>): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Endpoint discovery",
    "Resolve the exact Wire network group and required RPCs",
    [
      Steps.readiness.cluster.planEndpointCatalog(
        Report.Actor.Sysio,
        "endpoint-catalog",
        "Validate endpoint-catalog discovery for the selected Wire chain",
        {}
      ),
      Steps.readiness.cluster.planRequiredEndpoints(
        Report.Actor.Sysio,
        "required-endpoints",
        "Select Wire, Ethereum, and Solana endpoints",
        {}
      )
    ],
    { failureMode: ClusterBuildFailureMode.collect }
  )
}

function planClusterHealth(parent: ClusterBuildParent<ReadinessContext>): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Cluster health",
    "Verify identities, liveness, advancement, and optional indexing",
    [
      Steps.readiness.cluster.planWireIdentity(
        Report.Actor.Sysio,
        "wire-identity",
        "Verify the exact Wire chain id",
        {}
      ),
      Steps.readiness.cluster.planWireHeadAdvancement(
        Report.Actor.Sysio,
        "wire-head-advancement",
        "Observe Wire head-block advancement",
        {}
      ),
      Steps.readiness.cluster.planWireHeadFreshness(
        Report.Actor.Sysio,
        "wire-head-freshness",
        "Verify the Wire head timestamp is current",
        {}
      ),
      Steps.readiness.cluster.planEthereumIdentity(
        Report.Actor.EthereumOutpost,
        "ethereum-identity",
        "Verify the Ethereum chain id",
        {}
      ),
      Steps.readiness.cluster.planEthereumHeadAdvancement(
        Report.Actor.EthereumOutpost,
        "ethereum-head-advancement",
        "Observe Ethereum block advancement",
        {}
      ),
      Steps.readiness.cluster.planSolanaIdentity(
        Report.Actor.SolanaOutpost,
        "solana-identity",
        "Verify Solana health and genesis identity",
        {}
      ),
      Steps.readiness.cluster.planSolanaSlotAdvancement(
        Report.Actor.SolanaOutpost,
        "solana-slot-advancement",
        "Observe Solana slot advancement",
        {}
      ),
      Steps.readiness.cluster.planHyperionHealth(
        Report.Actor.Sysio,
        "hyperion-health",
        "Probe optional Hyperion indexer health",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planWireConfiguration(
  parent: ClusterBuildParent<ReadinessContext>
): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Swap protocol configuration",
    "Verify Wire swap contracts, epoch scheduling, and external-chain registry",
    [
      Steps.readiness.cluster.planWireContracts(
        Report.Actor.Sysio,
        "wire-contracts",
        "Verify required swap contract action and table surfaces",
        {}
      ),
      Steps.readiness.cluster.planEpochScheduler(
        Report.Actor.Sysio,
        "epoch-scheduler",
        "Verify the epoch scheduler is active",
        {}
      ),
      Steps.readiness.cluster.planChainRegistry(
        Report.Actor.Sysio,
        "chain-registry",
        "Verify active Ethereum and Solana registry rows",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planSwap(parent: ClusterBuildParent<ReadinessContext>): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Swap infrastructure",
    "Verify underwriting, assets, reserves, and backlog independently",
    [
      Steps.readiness.swap.planUnderwritingConfig(
        Report.Actor.Underwriter,
        "underwriting-config",
        "Validate live underwriting limits and fees",
        {}
      ),
      Steps.readiness.swap.planActiveUnderwriters(
        Report.Actor.Underwriter,
        "active-underwriters",
        "Verify an active underwriter satisfies the collateral matrix",
        {}
      ),
      Steps.readiness.swap.planExternalAssets(
        Report.Actor.Sysio,
        "external-assets",
        "Verify public reserve assets exist on their external chains",
        {}
      ),
      Steps.readiness.swap.planExternalCustody(
        Report.Actor.Sysio,
        "external-custody",
        "Verify each advertised reserve is configured and funded in external custody",
        {},
        false
      ),
      Steps.readiness.swap.planAssetRegistry(
        Report.Actor.Sysio,
        "asset-registry",
        "Verify advertised reserves have active token bindings",
        {}
      ),
      Steps.readiness.swap.planPublicReserves(
        Report.Actor.Sysio,
        "public-reserves",
        "Verify every advertised public depot book has positive liquidity",
        {}
      ),
      Steps.readiness.swap.planRequestBacklog(
        Report.Actor.Underwriter,
        "request-backlog",
        "Verify no expired pending underwriting requests remain",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )

  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Swap routes",
    "Construct and quote every public direction from live depot state",
    [
      Steps.readiness.swap.planRouteRegistry(
        Report.Actor.Sysio,
        "route-registry",
        "Construct directional routes from active reserves",
        {}
      ),
      Steps.readiness.swap.planRouteQuotes(
        Report.Actor.Sysio,
        "route-quotes",
        "Quote every constructed route with canonical depot math",
        {}
      )
    ],
    { failureMode: ClusterBuildFailureMode.collect }
  )
}

function planStake(parent: ClusterBuildParent<ReadinessContext>): void {
  ClusterBuildPhase.create<ReadinessContext>(
    parent,
    "Stake protocol",
    "Keep stake explicitly unavailable until the canonical lifecycle exists",
    [
      Steps.readiness.cluster.planStakeLifecycle(
        Report.Actor.User,
        "stake-lifecycle",
        "Report the unresolved end-to-end staking protocol gate",
        {}
      )
    ],
    { failureMode: ClusterBuildFailureMode.collect }
  )
}
