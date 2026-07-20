import Path from "node:path"
import { Report } from "../../report/Report.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { EthereumOutpostBootstrapper } from "./EthereumOutpostBootstrapper.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"

/** Steps that deploy + seed the Ethereum (anvil) outpost. */
export namespace EthereumOutpostSteps {
  /** Subpath (under the cluster data dir) for the annotated accounts file. */
  const AnvilDataSubpath = "anvil"

  /**
   * Deploy the Ethereum outpost against the already-running run anvil
   * (`Steps.processes.anvil.start` must precede this in the phase): deploy the
   * `wire-ethereum` contracts, seed the ReserveManager, and write the annotated
   * accounts file (later phases re-read `accounts.json` / `outpost-addrs.json`
   * from disk). Input-less — paths + the anvil port come from `ctx.config`.
   */
  export function planDeploy<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runDeploy
    )
  }

  /** Named runner — `EthereumOutpostBootstrapper.bootstrap` against the run anvil. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // Same derivation as AnvilProcess.rpcUrl — the run anvil was bound to this
    // exact port by Steps.processes.anvil.start, so they cannot diverge.
    await new EthereumOutpostBootstrapper({
      ethereumPath: ctx.config.ethereumPath,
      anvilDataPath: Path.join(ctx.config.dataPath, AnvilDataSubpath),
      rpcUrl: toURL(
        ctx.config.bind.anvil.port,
        toDialAddress(ctx.config.bind.anvil.address)
      ),
      deploymentsPath: ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    }).bootstrap()
  }
}
