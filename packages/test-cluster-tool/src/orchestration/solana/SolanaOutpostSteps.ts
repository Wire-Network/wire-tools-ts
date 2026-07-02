import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { SolanaOutpostBootstrapper } from "./SolanaOutpostBootstrapper.js"

/** Steps that deploy + seed the Solana (test-validator) outpost. */
export namespace SolanaOutpostSteps {
  /**
   * Deploy the Solana outpost: airdrop the deployer, initialize the opp-outpost
   * PDAs against the already-loaded program, seed the native-SOL reserve, and
   * provision mock SPL reserves (persisting `sol-mock-mints.json` for depot-side
   * token registration). Input-less — paths + RPC come from `ctx.config` /
   * `ctx.solana`; the validator must already be running.
   */
  export function deploy<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runDeploy)
  }

  /** Named runner — `SolanaOutpostBootstrapper.bootstrap`. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await new SolanaOutpostBootstrapper({
      solanaPath: ctx.config.solanaPath,
      rpcUrl: ctx.solana.rpcUrl,
      clusterDataPath: ctx.config.dataPath
    }).bootstrap()
  }
}
