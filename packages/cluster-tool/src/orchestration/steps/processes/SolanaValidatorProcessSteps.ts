import Path from "node:path"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import {
  SolanaValidatorProcess,
  type SolanaValidatorProgram
} from "../../../cluster/processes/SolanaValidatorProcess.js"
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
   * with every wire-solana program loaded upgradeable, the per-cluster deployer
   * as their upgrade authority. Idempotent.
   */
  export function planStart<
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
      runStart
    )
  }

  /** Named runner — get-or-create the {@link SolanaValidatorProcess} and start it. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.processManager.get(SolanaValidatorProcess.ProcessLabel) != null)
      return

    // THIS is the deploy: the validator loads the binary at genesis via
    // `--upgradeable-program`, so whatever sits at that path is what executes
    // on chain. Verify it against the recorded build BEFORE launching. The
    // shared `resolvePrograms` deliberately does NOT — see its JSDoc.
    SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program =>
      SolanaOutpostProgramTool.assertProgramSoFile(
        ctx.config.solanaPath,
        program
      )
    )
    const validator = await SolanaValidatorProcess.create(ctx.processManager, {
      address: ctx.config.bind.solana.address,
      rpcPort: ctx.config.bind.solana.ports.http,
      faucetPort: ctx.config.bind.solana.ports.faucet,
      gossipPort: ctx.config.bind.solana.ports.gossip,
      dynamicPortRange: ctx.config.bind.solana.ports.dynamicRange,
      ledgerPath: Path.join(
        ctx.config.dataPath,
        SolanaValidatorProcess.LedgerSubpath
      ),
      slotsPerEpoch: ctx.config.solanaSlotsPerEpoch,
      programs: resolvePrograms(ctx.config)
    })
    await validator.start()
  }

  /**
   * The BPF programs this cluster's validator loads at genesis — ALL FOUR
   * wire-solana Anchor programs
   * ({@link SolanaOutpostProgramTool.GenesisAnchorPrograms}).
   *
   * Shared by {@link runStart} and the `start.sh` renderer
   * (`StartScriptSteps.resolveSolanaValidatorConfig`) so the two cannot drift:
   * omitting these from the rendered argv produces a validator with NO
   * wire-solana programs at all, which fails as a one-direction OPP
   * circulation stall rather than a startup error.
   *
   * `liqsol_core` alone is not enough: the liqsol staking + syndication surface
   * the `init-*` scripts stand up (`SolanaLiqsolSurfaceSteps`) CPIs into
   * `liqsol_token` for the liqSOL mint and into `transfer_hook` on every
   * Token-2022 transfer, and the leaderboard init targets
   * `validator_leaderboard` — a missing sibling surfaces as an
   * `AccountNotExecutable` mid-bootstrap, not as a startup error.
   *
   * Each program is deployed UPGRADEABLE with the per-cluster deployer as its
   * upgrade authority — that same deployer becomes the `global_config.admin`
   * the OPP admin ops require (`initialize_global_config` proves it against
   * `liqsol_core`'s `ProgramData`). `createDeployerKeypair` is create-or-load,
   * so calling it from either path yields the identical identity.
   *
   * `soFile` is the PATH ONLY — this resolves what the argv must say, never
   * whether the binary on disk is the one the recorded build emitted. That
   * check belongs to whoever actually loads it, which is {@link runStart}
   * alone: the renderer emits a script that runs LATER, and often on ANOTHER
   * host — `create-external-config` clones a tree whose `wire-solana` was
   * never built here, so verifying against THIS checkout would reject a
   * perfectly good deployment payload while proving nothing about the host
   * that will run it.
   *
   * @param config - The resolved cluster config.
   * @returns The validator's program list.
   */
  export function resolvePrograms(
    config: ClusterConfig
  ): SolanaValidatorProgram[] {
    const upgradeAuthority = SolanaFundingTool.createDeployerKeypair(
      config.dataPath
    ).publicKey.toBase58()
    return SolanaOutpostProgramTool.GenesisAnchorPrograms.map(program => ({
      name: program,
      programId: SolanaOutpostProgramTool.assertProgramId(
        config.solanaPath,
        program
      ).toBase58(),
      soFile: SolanaOutpostProgramTool.programSoFile(
        config.solanaPath,
        program
      ),
      upgradeAuthority
    }))
  }
}
