import type { ClusterConfig } from "@wireio/cluster-tool-shared"

import { AnvilProcess } from "../cluster/processes/AnvilProcess.js"
import type { Logger } from "../logging/Logger.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { toDialAddress, toURL } from "../utils/netUtils.js"
import { createReadinessConfig } from "./ReadinessConfig.js"
import { type ReadinessCapable, ReadinessClient } from "./ReadinessContext.js"

/** Fresh-cluster FlowScenario context exposing the same readiness capability as the CLI. */
export class ClusterReadinessFlowContext
  extends ClusterBuildContext
  implements ReadinessCapable
{
  readonly readiness: ReadinessClient

  /** Bind read-only probes to the freshly bootstrapped cluster's resolved ports. */
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
