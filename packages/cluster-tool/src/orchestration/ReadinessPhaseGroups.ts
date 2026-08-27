import { Report } from "../report/Report.js"
import type { ReadinessCapable } from "../readiness/ReadinessContext.js"
import type { OrchestrationContext } from "./OrchestrationContext.js"
import { ClusterBuildFailureMode } from "./ClusterBuildFailureMode.js"
import { ClusterBuildPhase } from "./ClusterBuildPhase.js"
import type { ClusterBuildParent } from "./ClusterBuildPhaseBase.js"
import { ClusterBuildPhaseGroup } from "./ClusterBuildPhaseGroup.js"
import { Steps } from "./steps/index.js"

type ReadinessContext = OrchestrationContext & ReadinessCapable

/** Reusable read-only readiness compositions for connected and bootstrap flows. */
export namespace ReadinessPhaseGroups {
  /** Plan the complete cluster and swap preflight suite. */
  export function plan<C extends ReadinessContext>(
    parent: ClusterBuildParent<C>
  ): ClusterBuildPhaseGroup<C> {
    const readiness = ClusterBuildPhaseGroup.create<C>(
      parent,
      "cluster-readiness",
      "Read-only cluster and swap preflight evidence",
      { failureMode: ClusterBuildFailureMode.collect }
    )
    planInputs(readiness)
    planLiveness(readiness)
    planProtocol(readiness)
    planSwapCapacity(readiness)
    planRoutes(readiness)
    return readiness
  }
}

function planInputs<C extends ReadinessContext>(
  parent: ClusterBuildParent<C>
): void {
  ClusterBuildPhase.create<C>(
    parent,
    "Explicit endpoint identities",
    "Record caller-selected endpoints and verify all three chain identities",
    [
      Steps.readiness.cluster.planRequiredEndpoints(
        Report.Actor.Sysio,
        "required-endpoints",
        "Record explicit Wire, Ethereum, and Solana endpoints",
        {}
      ),
      Steps.readiness.cluster.planWireIdentity(
        Report.Actor.Sysio,
        "wire-identity",
        "Verify the Wire chain id",
        {}
      ),
      Steps.readiness.cluster.planEthereumIdentity(
        Report.Actor.EthereumOutpost,
        "ethereum-identity",
        "Verify the Ethereum chain id",
        {}
      ),
      Steps.readiness.cluster.planSolanaIdentity(
        Report.Actor.SolanaOutpost,
        "solana-identity",
        "Verify Solana health and genesis identity",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planLiveness<C extends ReadinessContext>(
  parent: ClusterBuildParent<C>
): void {
  const context = parent.context,
    timeoutMs =
      context.readiness.config.observationMs +
      context.readiness.config.timeoutMs +
      ReadinessPhaseGroups.AdvancementTimeoutBufferMs,
    steps = [
      Steps.readiness.cluster.planWireHeadAdvancement(
        Report.Actor.Sysio,
        "wire-head-advancement",
        "Observe Wire head-block advancement",
        { timeoutMs }
      ),
      Steps.readiness.cluster.planWireHeadFreshness(
        Report.Actor.Sysio,
        "wire-head-freshness",
        "Verify the Wire head timestamp is current",
        {}
      ),
      Steps.readiness.cluster.planEthereumHeadAdvancement(
        Report.Actor.EthereumOutpost,
        "ethereum-head-advancement",
        "Observe Ethereum block advancement",
        { timeoutMs }
      ),
      Steps.readiness.cluster.planSolanaSlotAdvancement(
        Report.Actor.SolanaOutpost,
        "solana-slot-advancement",
        "Observe Solana slot advancement",
        { timeoutMs }
      )
    ]
  if (context.readiness.config.endpoints.hyperionUrl != null) {
    steps.push(
      Steps.readiness.cluster.planHyperionHealth(
        Report.Actor.Sysio,
        "hyperion-health",
        "Probe the explicitly supplied Hyperion endpoint",
        {}
      )
    )
  }
  ClusterBuildPhase.create<C>(
    parent,
    "Chain liveness",
    "Verify head freshness and bounded advancement without writing chain state",
    steps,
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planProtocol<C extends ReadinessContext>(
  parent: ClusterBuildParent<C>
): void {
  ClusterBuildPhase.create<C>(
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
        "Verify the epoch scheduler is active or demonstrably catching up",
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

function planSwapCapacity<C extends ReadinessContext>(
  parent: ClusterBuildParent<C>
): void {
  ClusterBuildPhase.create<C>(
    parent,
    "Swap capacity",
    "Verify underwriting, external assets, reserve depth, and request backlog",
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
        "Verify active underwriter collateral coverage",
        {}
      ),
      Steps.readiness.swap.planExternalAssets(
        Report.Actor.Sysio,
        "external-assets",
        "Verify public reserve assets exist on their external chains",
        {}
      ),
      Steps.readiness.swap.planAssetRegistry(
        Report.Actor.Sysio,
        "asset-registry",
        "Verify public reserves have active token bindings",
        {}
      ),
      Steps.readiness.swap.planPublicReserves(
        Report.Actor.Sysio,
        "public-reserves",
        "Verify public reserve books have positive liquidity",
        {}
      ),
      Steps.readiness.swap.planRequestBacklog(
        Report.Actor.Underwriter,
        "request-backlog",
        "Verify expired pending underwriting requests are absent",
        {}
      )
    ],
    {
      parallelize: true,
      failureMode: ClusterBuildFailureMode.collect
    }
  )
}

function planRoutes<C extends ReadinessContext>(
  parent: ClusterBuildParent<C>
): void {
  ClusterBuildPhase.create<C>(
    parent,
    "Read-only swap routes",
    "Construct and quote every public direction from live depot state",
    [
      Steps.readiness.swap.planRouteRegistry(
        Report.Actor.Sysio,
        "route-registry",
        "Construct directional routes and canonical depot quotes",
        {}
      ),
      Steps.readiness.swap.planRouteQuotes(
        Report.Actor.Sysio,
        "route-quotes",
        "Require positive quotes and common collateral coverage",
        {}
      )
    ],
    { failureMode: ClusterBuildFailureMode.collect }
  )
}

/** Constants used by readiness PhaseGroup planning. */
export namespace ReadinessPhaseGroups {
  /** Prevent a Step timeout racing the final advancement poll or HTTP call. */
  export const AdvancementTimeoutBufferMs = 2_000
}
