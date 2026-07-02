import { SlugName } from "@wireio/sdk-core"

/**
 * Constants for the batch-operator-termination flow. Every amount, threshold,
 * and epoch budget carries over from the previously-validated flow run — those
 * values were tuned against live cluster runs, the timing budgets especially.
 * Every poll deadline derives from the epoch duration so the flow scales with
 * it.
 */
export namespace TerminationScenarioConstants {
  /**
   * The flow's DOOMED non-bootstrapped batch operator (provisioned by the
   * scenario; its daemon is deliberately never started). A short name well
   * under the 12-character `sysio::newaccount` cap that slots next to the
   * bootstrap's `batchop.[a-i]` roster without colliding.
   */
  export const DoomedOperatorAccount = "newop"
  /**
   * Anvil-mnemonic HD index for the operator's ETH wallet — past every
   * bootstrap operator slot (batchops + underwriters), and inside anvil's
   * pre-funded range (`AnvilProcess.AccountCount = 50`) so the wallet can pay
   * the deposit's gas without an explicit funding step.
   */
  export const DoomedOperatorEthereumHdIndex = 35
  /** Lamports airdropped to the operator's SOL keypair (bond + fee headroom). */
  export const DoomedOperatorAirdropLamports = 5_000_000_000n

  /** Epoch duration (s) — the bare-cluster working baseline (`sysio.epoch::setconfig` floor is 60). */
  export const EpochDurationSec = 60
  /**
   * Bootstrapped batch operators stood up by the harness. 9 → 3 odd-sized
   * groups of 3; with the doomed operator never delivering, the remaining 8
   * still cover consensus majority on every group.
   */
  export const BatchOperatorCount = 9
  /**
   * Override for `terminate_max_consecutive_misses` so `termcheck` fires inside
   * the flow's budget: 2 consecutive missed scheduled epochs flip TERMINATED.
   */
  export const TerminateMaxConsecutiveMisses = 2

  /**
   * Bond escrowed per chain (raw outpost units — wei / lamports). Both ledger
   * rows are zeroed on termination, so the exact value just needs to clear the
   * per-type minimum-bond floor below.
   */
  export const EthereumBondAmount = 2_000_000n
  export const SolanaBondAmount = 2_000_000n
  /** `requiredBatchOperatorCollateral` minimum-bond floor per chain (depot-side enforcement). */
  export const RequiredEthereumMinimumBond = 1_000_000
  export const RequiredSolanaMinimumBond = 1_000_000

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")

  /** Epochs budgeted for the ETH DEPOSIT_REQUEST to relay and credit the depot balance row. */
  export const EthereumDepositRelayEpochs = 4
  /** Epochs budgeted for the SOL DEPOSIT_REQUEST to relay + the ACTIVE eligibility flip. */
  export const SolanaActivationEpochs = 6
  /**
   * Epochs budgeted for the newly-ACTIVE operator to ride into a schedule-window
   * tail group — at most N advances after the ACTIVE flip (N=3 groups), and
   * non-bootstrapped operators are picked first.
   */
  export const ScheduleWindowEpochs = 5
  /**
   * Epochs to wait for termination once the operator is in rotation. With
   * `TerminateMaxConsecutiveMisses = 2` and 3 groups, the operator's slot
   * rotates every 3 epochs in the worst case, so 10 epochs is comfortably above
   * the ~6-epoch theoretical worst.
   */
  export const MissAccumulationEpochs = 10
  /** Epochs allowed for each WITHDRAW_REMIT outbound → cranker → outpost round-trip after termination. */
  export const RemitPropagationEpochs = 8

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000
  /** Timeout for a single outpost deposit write (tx submit + confirm). */
  export const DepositStepTimeoutMs = 60_000
  /** Timeout for direct-read verify steps (no chain-state poll involved). */
  export const QuickVerifyTimeoutMs = 30_000

  /** `getCode` length floor proving a contract is deployed (above the `"0x"` empty response). */
  export const MinimumContractCodeLength = 4
  /** Row budget when scanning `sysio.opreg::operators` for the doomed operator. */
  export const OperatorsQueryLimit = 100
  /** Row budget for the `sysio.epoch::epochstate` singleton read. */
  export const EpochStateQueryLimit = 1
  /** Anchor account-namespace name of the SOL outpost's `OperatorRegistry` PDA account. */
  export const SolanaOperatorRegistryAccountName = "operatorRegistry"

  /** Deadline for the ETH deposit to credit the depot balance row. */
  export function ethereumDepositDeadlineMs(): number {
    return EpochDurationSec * EthereumDepositRelayEpochs * MsPerSecond
  }

  /** Deadline for the SOL deposit to land and the ACTIVE flip to follow. */
  export function solanaActivationDeadlineMs(): number {
    return EpochDurationSec * SolanaActivationEpochs * MsPerSecond
  }

  /** Deadline for the operator to appear in `epochstate.batch_op_groups`. */
  export function scheduleWindowDeadlineMs(): number {
    return EpochDurationSec * ScheduleWindowEpochs * MsPerSecond
  }

  /** Deadline for the miss window to accumulate and `termcheck` to flip TERMINATED. */
  export function terminationDeadlineMs(): number {
    return EpochDurationSec * MissAccumulationEpochs * MsPerSecond
  }

  /** Deadline for the post-termination WITHDRAW_REMIT effects on either outpost. */
  export function remitDeadlineMs(): number {
    return EpochDurationSec * RemitPropagationEpochs * MsPerSecond
  }
}
