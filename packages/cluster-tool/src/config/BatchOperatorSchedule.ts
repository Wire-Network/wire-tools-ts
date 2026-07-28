import Assert from "node:assert"

/**
 * The depot's batch-operator sliding-window schedule: group SIZE
 * (`operators_per_epoch`), group COUNT (`batch_op_groups`), and the scheduled
 * total (`batch_operator_minimum_active`) that `sysio.epoch::schbatchgps`
 * requires the ACTIVE roster to cover.
 *
 * Resolved and validated in ONE place ({@link BatchOperatorSchedule.resolve}) so
 * the CLI/flow boundary and the `epoch::setconfig` step can never disagree, and
 * so an illegal topology is rejected before a cluster's worth of ports is
 * claimed rather than ~15 minutes later on chain.
 */
export interface BatchOperatorSchedule {
  /** `operators_per_epoch` — members per group; always ODD. */
  readonly operatorsPerEpoch: number
  /** `batch_op_groups` — the sliding-window group count. */
  readonly batchOpGroups: number
  /** `batch_operator_minimum_active` — `operatorsPerEpoch × batchOpGroups`. */
  readonly batchOperatorMinimumActive: number
}

export namespace BatchOperatorSchedule {
  /**
   * Default `batch_op_groups`. Changing it changes the legal DERIVED roster
   * lattice AND the "on duty once every N epochs" rotation that
   * `sysio.opreg`'s termination window is validated against.
   */
  export const DefaultBatchOperatorGroupCount = 3
  /**
   * Floor for the derived group SIZE — the depot rejects a zero size, so a
   * group COUNT wider than the roster still derives one-member groups (and then
   * fails the fits-the-roster assert with the flags named).
   */
  export const MinimumOperatorsPerEpoch = 1

  /**
   * Depot ceilings, mirrored from `sysio.epoch.hpp` so an over-large topology
   * fails HERE instead of inside `sysio.epoch::setconfig` after the whole
   * cluster has been stood up. Keep in lock-step with the contract.
   */
  export const MaxOperatorsPerEpoch = 100
  export const MaxBatchOperatorGroups = 255
  export const MaxScheduledBatchOperators = 1000

  /**
   * HARNESS ceiling on the roster — not a depot limit.
   * `Constants.batchOperatorAccountName` names operators `batchop.<letter>` off
   * a 26-letter alphabet and wraps modulo its length, so index 26 would collide
   * with index 0: two operators would share one WIRE account, parallel
   * provisioning would try to create it twice, and their node/key config would
   * reuse a single identity. The depot itself would accept a larger roster
   * (`27 = 9 x 3` is a legal shape), so raising this means giving
   * `batchOperatorAccountName` a unique suffix past 26 first -- the way
   * `producerName` already does.
   */
  export const MaxBatchOperatorRoster = 26

  /** Whether `value` is a positive whole number (the depot's `> 0` uint32 fields). */
  function isPositiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0
  }

  /**
   * The largest ODD group SIZE that fits `batchOperatorCount` into
   * `batchOpGroups` groups: `floor(count / groups)` rounded DOWN to odd, floored
   * at {@link MinimumOperatorsPerEpoch}.
   *
   * FLOOR because `schbatchgps` asserts the ACTIVE pool is at least
   * `size × groups`; ODD because the depot's path-2 consensus threshold is a
   * strict group majority (`opp-consensus.md`).
   *
   * @param batchOperatorCount - Bootstrapped batch operators in the roster.
   * @param batchOpGroups - The sliding-window group COUNT (positive).
   * @returns The derived group size.
   */
  function deriveOperatorsPerEpoch(
    batchOperatorCount: number,
    batchOpGroups: number
  ): number {
    const fits = Math.floor(batchOperatorCount / batchOpGroups),
      odd = fits % 2 === 0 ? fits - 1 : fits
    return Math.max(MinimumOperatorsPerEpoch, odd)
  }

  /**
   * Resolve the schedule from the topology plus any explicit overrides, and
   * assert every invariant the depot enforces.
   *
   * The spec, with `groups` defaulting to
   * {@link DefaultBatchOperatorGroupCount}:
   *
   * ```
   * groups = 3
   * assert(group_size % 2 == 1)
   * total  = groups * group_size
   * ```
   *
   * On the DERIVED path (no overrides) that admits exactly the ODD multiples of
   * 3 — `3, 9, 15, 21, 27, …` — because `count / 3` must be a whole ODD number
   * for `total` to equal the roster. That roster lattice is asserted ONLY when
   * the shape is derived: an operator who states an explicit shape is held to
   * what the depot actually requires (`total <= roster`), so e.g.
   * `{ count: 6, operatorsPerEpoch: 1, batchOpGroups: 3 }` is legal.
   *
   * @param batchOperatorCount - The bootstrapped batch-operator roster size.
   * @param operatorsPerEpoch - Explicit group SIZE, or null/undefined to derive.
   * @param batchOpGroups - Explicit group COUNT, or null/undefined for the default.
   * @returns The validated schedule.
   * @throws If any depot invariant or ceiling would be violated.
   */
  export function resolve(
    batchOperatorCount: number,
    operatorsPerEpoch?: number,
    batchOpGroups?: number
  ): BatchOperatorSchedule {
    Assert.ok(
      isPositiveInteger(batchOperatorCount),
      `batch-operator-count must be a positive whole number — got ${batchOperatorCount}`
    )
    Assert.ok(
      batchOperatorCount <= MaxBatchOperatorRoster,
      `batch-operator-count ${batchOperatorCount} exceeds the harness ceiling of ` +
        `${MaxBatchOperatorRoster} — operator accounts are named batchop.<letter> off a ` +
        `${MaxBatchOperatorRoster}-letter alphabet, so a larger roster would reuse identities`
    )
    // Group COUNT first: the size derivation divides by it, so a zero, negative
    // or fractional count must never reach that division (it used to yield a
    // size of 1 alongside a count of 0, which the depot then rejected).
    const groups = batchOpGroups ?? DefaultBatchOperatorGroupCount
    Assert.ok(
      isPositiveInteger(groups),
      `batch-op-groups must be a positive whole number — got ${groups}`
    )
    Assert.ok(
      groups <= MaxBatchOperatorGroups,
      `batch-op-groups ${groups} exceeds the depot ceiling of ${MaxBatchOperatorGroups}`
    )

    // DERIVED = the caller stated NEITHER half of the shape. An explicit group
    // COUNT takes them off the `groups = 3` lattice just as an explicit size does.
    const isDerived = operatorsPerEpoch == null && batchOpGroups == null,
      size = operatorsPerEpoch ?? deriveOperatorsPerEpoch(batchOperatorCount, groups)
    Assert.ok(
      isPositiveInteger(size),
      `operators-per-epoch must be a positive whole number — got ${size}`
    )
    Assert.ok(
      size % 2 === 1,
      `batch-op group SIZE must be ODD — got operators-per-epoch ${size} ` +
        `(an even group has no strict majority, so the depot's path-2 consensus threshold is undefined)`
    )
    Assert.ok(
      size <= MaxOperatorsPerEpoch,
      `operators-per-epoch ${size} exceeds the depot ceiling of ${MaxOperatorsPerEpoch}` +
        (isDerived
          ? ` — derived from batch-operator-count ${batchOperatorCount} / ${groups} groups`
          : "")
    )

    const total = size * groups
    Assert.ok(
      total <= MaxScheduledBatchOperators,
      `batch_operator_minimum_active ${total} exceeds the depot ceiling of ${MaxScheduledBatchOperators}`
    )
    // DERIVED path only: the default shape is exact, so the roster must sit on
    // the lattice. An explicit shape is already fully validated above.
    Assert.ok(
      !isDerived || batchOperatorCount % 2 === 1,
      `batch-operator-count must be ODD and divisible by ${DefaultBatchOperatorGroupCount} ` +
        `(3, 9, 15, 21, 27, …) — got ${batchOperatorCount}; ` +
        `pass --operators-per-epoch / --batch-op-groups to state a shape explicitly`
    )
    Assert.ok(
      !isDerived || total === batchOperatorCount,
      `batch-operator-count must be ODD and divisible by ${DefaultBatchOperatorGroupCount} ` +
        `(3, 9, 15, 21, 27, …) — got ${batchOperatorCount}; ` +
        `pass --operators-per-epoch / --batch-op-groups to state a shape explicitly`
    )

    // What `schbatchgps` actually asserts: the ACTIVE pool must fill the initial
    // window. Every bootstrapped operator is ACTIVE on registration, so the
    // roster size IS the available pool.
    Assert.ok(
      total <= batchOperatorCount,
      `batch-operator group shape needs ${total} ACTIVE batch operators ` +
        `(operators-per-epoch ${size} × batch-op-groups ${groups}) ` +
        `but batch-operator-count is ${batchOperatorCount} — raise --batch-operator-count ` +
        `or lower --operators-per-epoch / --batch-op-groups`
    )
    return {
      operatorsPerEpoch: size,
      batchOpGroups: groups,
      batchOperatorMinimumActive: total
    }
  }
}
