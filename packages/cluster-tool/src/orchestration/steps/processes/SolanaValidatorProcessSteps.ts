import Fs from "node:fs"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import { SolanaValidatorProcess } from "../../../cluster/processes/SolanaValidatorProcess.js"
import { SolanaOutpostProgramTool } from "../../../tools/solana/SolanaOutpostProgramTool.js"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import { OppSolProgram } from "../../solana/OppSolProgram.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"

/** Steps that manage the cluster's solana-test-validator process. */
export namespace SolanaValidatorProcessSteps {
  /**
   * Resolve (creating on first call) the per-cluster SOL deployer keypair and
   * return its base58 pubkey — used as the program's upgrade authority.
   * Persisted at `deployerFile` so `SolanaOutpostBootstrapper` loads the
   * identical keypair to sign OPP admin instructions. Idempotent: once the file
   * exists it is read back verbatim, so repeat calls return the SAME pubkey.
   *
   * @param deployerFile - absolute path to the deployer keypair JSON.
   * @return the deployer's base58 public key.
   */
  export function resolveUpgradeAuthority(deployerFile: string): string {
    if (!Fs.existsSync(deployerFile)) {
      Fs.mkdirSync(Path.dirname(deployerFile), { recursive: true })
      Fs.writeFileSync(deployerFile, JSON.stringify(Array.from(Keypair.generate().secretKey)))
    }
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(Fs.readFileSync(deployerFile, "utf8")))
    ).publicKey.toBase58()
  }

  /**
   * The solana-test-validator epoch-warp CLI arguments for a cluster: the
   * `--slots-per-epoch` / `--warp-slot` pair from {@link OppSolProgram} when the
   * per-cluster {@link ClusterConfig.solanaEpochWarp} opt-in is set, or an empty
   * array when it is off (every flow but `flow-yield-distribution`). Warping
   * advances the Solana clock minutes ahead — tripping the depot's `sysio.authex`
   * 10-minute nonce window on cross-chain SOL deposits — so only the yield flow
   * (whose reward routes through `sysio.dclaim`, no such check) enables it.
   *
   * @param solanaEpochWarp - the resolved `ClusterConfig.solanaEpochWarp` flag.
   * @return the warp validator args, or `[]` when warp is off.
   */
  export function solanaWarpArgs(solanaEpochWarp: boolean): string[] {
    return solanaEpochWarp
      ? [
          "--slots-per-epoch",
          OppSolProgram.solanaWarpSlotsPerEpoch,
          "--warp-slot",
          OppSolProgram.solanaWarpSlot
        ]
      : []
  }

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
    const upgradeAuthority = resolveUpgradeAuthority(
      OppSolProgram.clusterDeployerKeypairFile(ctx.config.dataPath)
    )

    // Per-cluster opt-in (`ClusterConfig.solanaEpochWarp`, set only by
    // `flow-yield-distribution`'s scenario `defaults`): warp the validator past
    // Solana epoch 3 for `flush_staking_yield` (which requires `Clock.epoch >=
    // 3`). Off by default so every other flow keeps the real-time clock — see
    // `solanaWarpArgs` for why.
    const extraArgs = solanaWarpArgs(ctx.config.solanaEpochWarp)

    const validator = await SolanaValidatorProcess.create(ctx.processManager, {
      address: ctx.config.bind.solana.address,
      rpcPort: ctx.config.bind.solana.ports.http,
      faucetPort: ctx.config.bind.solana.ports.faucet,
      gossipPort: ctx.config.bind.solana.ports.gossip,
      dynamicPortRange: ctx.config.bind.solana.ports.dynamicRange,
      ledgerPath: Path.join(ctx.config.dataPath, SolanaValidatorProcess.LedgerSubpath),
      programs: [{ name: SolanaOutpostProgramTool.ProgramName, programId, soFile, upgradeAuthority }],
      ...(extraArgs.length > 0 ? { extraArgs } : {})
    })
    await validator.start()
  }
}
