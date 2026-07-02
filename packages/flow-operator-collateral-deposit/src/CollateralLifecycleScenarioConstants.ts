import { SlugName } from "@wireio/sdk-core"

/**
 * Constants for the collateral-lifecycle flow. Amounts + epoch budgets carry
 * over from the previously-validated flow run (2026-06): the bond is deposited
 * on BOTH outpost chains (all-chain collateral invariant), half the ETH bond is
 * withdrawn mid-flow, and every poll deadline derives from the epoch duration so
 * the flow scales with it.
 */
export namespace CollateralLifecycleScenarioConstants {
  /** The flow's NON-bootstrapped batch operator (provisioned by the scenario). */
  export const DepositorAccount = "depositor"
  /** Anvil-mnemonic HD index for the depositor's ETH wallet (past every bootstrap slot). */
  export const DepositorEthereumHdIndex = 35
  /** Lamports airdropped to the depositor's SOL keypair (bond + fees headroom). */
  export const DepositorAirdropLamports = 5_000_000_000n

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /** Collateral bonded per chain (raw outpost units — wei / lamports). */
  export const BondAmount = 2_000_000n
  /** ETH bond released mid-flow (half — stays above the minimum on the rest). */
  export const WithdrawAmount = 1_000_000n
  /** Escrow expected on the ETH outpost after the withdraw remit. */
  export const ExpectedRemainingBalance = BondAmount - WithdrawAmount

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")

  /** Epochs budgeted for a deposit/withdraw REQUEST to relay + settle on the depot. */
  export const RelayEpochBudget = 9
  /** Epochs budgeted for the withdraw wait window + flush + REMIT propagation. */
  export const RemitEpochBudget = 12

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /** Deadline for depot-side relay effects (balance row / status / queue row). */
  export function relayDeadlineMs(): number {
    return EpochDurationSec * RelayEpochBudget * MsPerSecond
  }

  /** Deadline for the withdraw wait window + flush + outpost remit. */
  export function remitDeadlineMs(): number {
    return EpochDurationSec * RemitEpochBudget * MsPerSecond
  }
}
