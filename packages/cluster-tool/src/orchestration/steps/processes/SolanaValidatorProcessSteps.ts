import Path from "node:path"
import { SolanaValidatorProcess } from "../../../cluster/processes/SolanaValidatorProcess.js"
import { SolanaFundingTool } from "../../../tools/solana/SolanaFundingTool.js"
import { SolanaOutpostProgramTool } from "../../../tools/solana/SolanaOutpostProgramTool.js"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"

/** Steps that manage the cluster's solana-test-validator process. */
export namespace SolanaValidatorProcessSteps {
  /**
   * Start the solana-test-validator (get-or-create from `ctx.processManager`)
   * with the `liqsol_core` program (hosting the OPP outpost interface) loaded
   * upgradeable, the per-cluster deployer as its upgrade authority. Idempotent.
   */
  export function planStart<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runStart)
  }

  /** Named runner — get-or-create the {@link SolanaValidatorProcess} and start it. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.processManager.get(SolanaValidatorProcess.ProcessLabel) != null) return

    const programId = SolanaOutpostProgramTool.assertProgramId(ctx.config.solanaPath)
      .toBase58()
    const soFile = SolanaOutpostProgramTool.programSoFile(ctx.config.solanaPath)

    // The program is deployed UPGRADEABLE with the per-cluster deployer as its
    // upgrade authority — that same deployer becomes the `global_config.admin`
    // the OPP admin ops require. Materialize the keypair here (before launch) so
    // `SolanaOutpostBootstrapper` loads the identical identity.
    const upgradeAuthority = SolanaFundingTool.createDeployerKeypair(ctx.config.dataPath)
      .publicKey.toBase58()

    const validator = await SolanaValidatorProcess.create(ctx.processManager, {
      address: ctx.config.bind.solana.address,
      rpcPort: ctx.config.bind.solana.ports.http,
      faucetPort: ctx.config.bind.solana.ports.faucet,
      gossipPort: ctx.config.bind.solana.ports.gossip,
      dynamicPortRange: ctx.config.bind.solana.ports.dynamicRange,
      ledgerPath: Path.join(ctx.config.dataPath, SolanaValidatorProcess.LedgerSubpath),
      programs: [
        { name: SolanaOutpostProgramTool.ProgramName, programId, soFile, upgradeAuthority }
      ]
    })
    await validator.start()
  }
}
