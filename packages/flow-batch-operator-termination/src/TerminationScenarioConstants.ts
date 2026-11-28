import { OutpostChainCodename } from "@wireio/cluster-tool-shared"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the batch-operator-termination flow: the doomed operator's
 * identity and the chain it serves, the eviction threshold, the WIRE bond it posts on the depot
 * through `sysio.opreg::deposit` (in depot atomic units — WIRE has 9
 * decimals), and the epoch budgets of its waits. Every poll deadline derives
 * from the epoch duration so the flow scales with it.
 */
export namespace TerminationScenarioConstants {
  /**
   * The flow's DOOMED non-bootstrapped batch operator's durable harness `label`
   * handle (provisioned by the scenario; its daemon is deliberately never
   * started), which is also its on-chain `account`. Slots next to the
   * bootstrap's `batchop.[a-i]` roster without colliding.
   */
  export const DoomedOperatorLabel = "newop"

  /**
   * The outpost chain the doomed operator serves and misses — the one chain its
   * miss rails evict it from.
   */
  export const MissedChain = OutpostChainCodename.ETHEREUM
  /** The outpost chain the doomed operator never joins, so it never holds a membership there. */
  export const UnservedChain = OutpostChainCodename.SOLANA
  /** The `status_reason` governance terminates the evicted operator with. */
  export const GovernanceTerminationReason = "governance termination after a chain eviction"

  /** Consensus epoch duration (s) of every outpost chain — the bare-cluster working baseline. */
  export const EpochDurationSec = 60
  /**
   * Bootstrapped batch operators stood up by the harness. 9 → 3 odd-sized
   * groups of 3; with the doomed operator never delivering, the remaining 8
   * still cover consensus majority on every group.
   */
  export const BatchOperatorCount = 9
  /**
   * Override for `terminate_max_consecutive_misses`: a run of more than 2 missed
   * scheduled epochs of the missed chain evicts it by the consecutive rail.
   */
  export const TerminateMaxConsecutiveMisses = 2
  /**
   * Override for `terminate_min_pct_samples` so `termcheck` fires inside the
   * flow's budget: the percent rail applies from the operator's second duty
   * epoch of the missed chain, so 2 missed scheduled epochs (a 100 % miss rate,
   * above the 5 % default) flip its membership EVICTED, one before the
   * consecutive rail would.
   */
  export const TerminateMinimumPercentSamples = 2

  /** `requiredBatchOperatorCollateral` `(WIRE, WIRE)` minimum — 1 WIRE. */
  export const MinimumBond = 1_000_000_000n
  /**
   * WIRE bonded in total — 2 WIRE. The eviction leaves it bonded; governance
   * termination credits the whole of it to the operator's WIRE claim, so the
   * exact value just needs to clear the minimum.
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
   * Epochs of the missed chain to wait for the eviction once the operator is in its rotation. With
   * `TerminateMinimumPercentSamples = 2` and 3 groups, the operator's slot
   * rotates every 3 epochs in the worst case, and the eviction lands at the advance
   * after its second missed epoch, which closes that epoch's books, so 10 epochs is
   * comfortably above the ~7-epoch theoretical worst.
   */
  export const MissAccumulationEpochs = 10

  /**
   * Epochs of the missed chain to wait, after the eviction, for the seat its window drew for the
   * operator before it to slide out: the slide out of its last duty epoch re-seats it in the tail
   * group, the eviction lands one advance later, and with the flow's 3 groups that tail group slides
   * out two advances after the eviction; the rest is margin. Changing it moves the wait's deadline.
   */
  export const EvictedSeatEpochs = 4

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Timeout for direct-read verify steps (no chain-state poll involved). */
  export const QuickVerifyTimeoutMs = 30_000

  /** `getCode` length floor proving a contract is deployed (above the `"0x"` empty response). */
  export const MinimumContractCodeLength = 4

  /**
   * Epochs of a chain a post-eviction rotation allows on top of its window's groups: the one that
   * accepts the rotation's final envelope. Changing it moves the rotation deadline.
   */
  export const RotationFinalEnvelopeEpochs = 1

  /**
   * Deadline for the operator to appear in the missed chain's `epochstate.batch_op_groups` (ms).
   *
   * @returns {@link ScheduleWindowEpochs} effective epochs of {@link EpochDurationSec}.
   */
  export function scheduleWindowDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochsMs(EpochDurationSec, ScheduleWindowEpochs)
  }

  /**
   * Deadline for the miss window to accumulate and `termcheck` to flip the membership EVICTED (ms).
   *
   * @returns {@link MissAccumulationEpochs} effective epochs of {@link EpochDurationSec}.
   */
  export function terminationDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochsMs(EpochDurationSec, MissAccumulationEpochs)
  }

  /**
   * Deadline for the seat drawn for the operator before its eviction to slide out of the missed
   * chain's window (ms).
   *
   * @returns {@link EvictedSeatEpochs} effective epochs of {@link EpochDurationSec}.
   */
  export function evictedSeatDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochsMs(EpochDurationSec, EvictedSeatEpochs)
  }
}
