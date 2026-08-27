import type { ClusterConfig } from "@wireio/cluster-tool-shared"

import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { createReadinessConfig } from "../../config/ReadinessConfig.js"
import { ReadinessClient } from "../../clients/readiness/ReadinessClient.js"
import type { Logger } from "../../logging/Logger.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import type { ReadinessCapable } from "../../orchestration/contexts/ConnectedReadinessContext.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"

/** Fresh-cluster FlowScenario context exposing the same readiness capability as the CLI. */
export class ClusterReadinessFlowContext
  extends ClusterBuildContext
  implements ReadinessCapable
{
  /** Read-only clients bound to the freshly bootstrapped cluster. */
  readonly readiness: ReadinessClient

  /**
   * Bind read-only probes to the freshly bootstrapped cluster's resolved ports.
   *
   * @param config - Resolved cluster configuration.
   * @param log - Logger used by the orchestration engine.
   * @param request - Fetch implementation used by readiness clients.
   */
  constructor(
    config: ClusterConfig,
    log: Logger,
    request: typeof fetch = globalThis.fetch
  ) {
    super(config, log)
    const expectedEthereumChainId = config.externalOutposts
      ? config.externalOutposts.ethereum.chainId
      : AnvilProcess.DefaultChainId
    this.readiness = new ReadinessClient(
      createReadinessConfig({
        wireRpc: ClusterBuildContext.nodeopUrl(config),
        ethereumRpc: toURL(
          config.bind.anvil.port,
          toDialAddress(config.bind.anvil.address)
        ),
        solanaRpc: toURL(
          config.bind.solana.ports.http,
          toDialAddress(config.bind.solana.address)
        ),
        expectedEthereumChainId,
        report: config.report
      }),
      request
    )
  }
}
