import { WireOperatorProvisioningTool } from "@wireio/cluster-tool"

/**
 * Constants for the collateral-lifecycle flow. The operator bonds WIRE on the depot
 * through `sysio.opreg::deposit`, withdraws half of it, and pulls the matured withdrawal
 * with `claimremit`. Every amount is in depot atomic units (WIRE has 9 decimals). The one
 * epoch-bound wait — the withdrawal maturing into a claim — is `WireCollateralTool`'s
 * remit-claim deadline, derived from the cluster's resolved epoch duration, so the flow scales
 * with the epoch duration and survives extended epochs.
 */
export namespace CollateralLifecycleScenarioConstants {
  /** The flow's NON-bootstrapped batch operator's durable harness `label` handle, which is also its on-chain `account`. */
  export const DepositorLabel = "depositor"
  /**
   * Wei the depositor's random ETH wallet is funded to (one `anvil_setBalance`): its daemon
   * pays the gas on every Ethereum delivery once the schedule picks it up, and an unfunded fee
   * payer never delivers. The harness's flow-operator default; changing it changes how many
   * deliveries the daemon can pay for.
   */
  export const DepositorFundEthereumWei =
    WireOperatorProvisioningTool.DefaultEthereumFundWei
  /**
   * Lamports airdropped to the depositor's SOL keypair: its daemon pays the fee on every
   * Solana `epoch_in` delivery once the schedule picks it up. Changing it changes how many
   * deliveries the daemon can pay for.
   */
  export const DepositorAirdropLamports = 5_000_000_000n

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /**
   * Ad-hoc port pairs this flow reserves: one, for the batch-operator daemon it starts itself.
   *
   * Reserved through `adHocCount` rather than picked when the daemon spawns — a pair picked at
   * spawn time never reaches the port registry, so a parallel resolver can hand the same port to
   * a planned daemon before this one binds.
   */
  export const AdHocDaemonCount = 1

  /** WIRE bonded on the depot — 2 WIRE. */
  export const BondAmount = 2_000_000_000n
  /** WIRE withdrawn mid-flow — half the bond. */
  export const WithdrawAmount = 1_000_000_000n
  /** The `(WIRE, WIRE)` balance row once the withdrawal has flushed. */
  export const ExpectedRemainingBalance = BondAmount - WithdrawAmount
  /**
   * The batch-operator minimum the flow installs: exactly what remains after the withdrawal,
   * so the operator stays ACTIVE on the remainder while the bond alone clears it.
   */
  export const MinimumBond = ExpectedRemainingBalance
}
