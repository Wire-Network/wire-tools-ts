import Path from "node:path"

/**
 * Constants for the folded-`liqsol_core` OPP Solana outpost. The artifact
 * identity (program keypair / `.so` / IDL / init instruction) is owned by
 * {@link SolanaOutpostProgramTool}, which targets the `liqsol_core` program
 * directly; this namespace carries the extras that program's OPP interface
 * requires: the upgradeable-deploy + `global_config` gating, and the epoch-warp
 * validator arguments for the staking-yield flush.
 *
 * Every OPP admin op (`initialize_outpost`, `set_token_address`,
 * `set_token_precision`, `init_reserve`, `create_reserve_native`,
 * `create_reserve_spl_authority`) is gated by a `global_config` PDA whose
 * `admin` is the program's on-chain upgrade authority — so the program is
 * deployed UPGRADEABLE (a `ProgramData` account exists) and
 * `initialize_global_config` runs once before the outpost is initialized.
 *
 * The epoch warp is NOT a global here: it is a per-cluster
 * {@link ClusterConfig.solanaEpochWarp} option a flow opts into via its
 * scenario `defaults` (only `flow-yield-distribution` does). These constants
 * are the validator arguments that warp applies.
 */
export namespace OppSolProgram {
  /**
   * `--slots-per-epoch` for the warp — epochs stretched so all
   * `dev_seed_staker_yield` seeding plus the flush land in ONE epoch (the reward's
   * `external_epoch_ref` derives from the Solana epoch, so a mid-flow rollover
   * would move the ref out from under the depot's dedupe check).
   */
  export const solanaWarpSlotsPerEpoch: string = "4096"
  /**
   * `--warp-slot` target — just past the epoch-3 boundary (3 * 4096 = 12288). It
   * MUST land in epoch 3 exactly: a single-node test-validator can build epoch
   * 3's leader schedule from genesis stakes and keep producing, but warping
   * straight into epoch 4+ leaves it unable to derive the schedule and it never
   * produces a block.
   */
  export const solanaWarpSlot: string = "12300"

  /** Seed of the shared liqsol `global_config` PDA (`has_one = admin`). */
  export const globalConfigSeed: string = "global_config"

  /** BPF upgradeable-loader program id — parent of every program's `ProgramData` PDA. */
  export const bpfLoaderUpgradeableProgramId: string =
    "BPFLoaderUpgradeab1e11111111111111111111111"

  /**
   * Basename of the per-cluster SOL deployer keypair. In integrated mode this
   * keypair is the program's upgrade authority (set at validator launch via
   * `--upgradeable-program`) AND the outpost `admin`, so it MUST be resolved
   * identically at validator-launch and outpost-bootstrap time.
   */
  export const deployerKeypairFilename: string = "sol-deployer-keypair.json"

  /**
   * Absolute path to the per-cluster SOL deployer keypair under the cluster data
   * dir — the single source of truth for the upgrade-authority/admin identity in
   * integrated mode.
   *
   * @param clusterDataPath - cluster data directory.
   * @return absolute path to `<clusterDataPath>/sol-deployer-keypair.json`.
   */
  export function clusterDeployerKeypairFile(clusterDataPath: string): string {
    return Path.join(clusterDataPath, deployerKeypairFilename)
  }
}
