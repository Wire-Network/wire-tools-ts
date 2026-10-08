import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the batch-operator-termination flow: the doomed operator's
 * identity, the termination threshold, the WIRE bond it posts on the depot
 * through `sysio.opreg::deposit` (in depot atomic units — WIRE has 9
 * decimals), and the epoch budgets of its waits. Every poll deadline derives
 * from the epoch duration so the flow scales with it.
 */
export namespace TerminationScenarioConstants {
  /**
   * The flow's DOOMED non-bootstrapped batch operator's durable harness `label`
   * handle (provisioned by the scenario; its daemon is deliberately never
   * started). Harness-side only — its on-chain `account` is node-owner-generated
   * (`wireno.<random>`). Slots next to the bootstrap's `batchop.[a-i]` roster
   * without colliding.
   */
  export const DoomedOperatorLabel = "newop"
  /**
   * Anvil-mnemonic HD index for the operator's ETH identity, which backs its
   * Ethereum authex link — past every bootstrap operator slot (batchops +
   * underwriters).
   */
  export const DoomedOperatorEthereumHdIndex = 35

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

  /** `requiredBatchOperatorCollateral` `(WIRE, WIRE)` minimum — 1 WIRE. */
  export const MinimumBond = 1_000_000_000n
  /**
   * WIRE bonded in total — 2 WIRE. Termination credits the whole of it to the
   * operator's WIRE claim, so the exact value just needs to clear the minimum.
   */
  export const BondAmount = 2_000_000_000n
  /** The first deposit — half the minimum, so the operator stays UNKNOWN on it. */
  export const FirstDepositAmount = MinimumBond / 2n
  /** The second deposit — the rest of the bond, which crosses the minimum. */
  export const SecondDepositAmount = BondAmount - FirstDepositAmount
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

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Timeout for direct-read verify steps (no chain-state poll involved). */
  export const QuickVerifyTimeoutMs = 30_000

  /** `getCode` length floor proving a contract is deployed (above the `"0x"` empty response). */
  export const MinimumContractCodeLength = 4

  /** Deadline for the operator to appear in `epochstate.batch_op_groups`. */
  export function scheduleWindowDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochSec(EpochDurationSec) * ScheduleWindowEpochs * ProtocolTiming.MsPerSecond
  }

  /** Deadline for the miss window to accumulate and `termcheck` to flip TERMINATED. */
  export function terminationDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochSec(EpochDurationSec) * MissAccumulationEpochs * ProtocolTiming.MsPerSecond
  }
}
