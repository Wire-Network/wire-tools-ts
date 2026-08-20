import { Either } from "@3fv/prelude-ts"
import { NestedError } from "@wireio/shared"
import { z } from "zod"

/**
 * Default `batch_op_groups`. Changing it changes the legal DERIVED roster
 * lattice AND the "on duty once every N epochs" rotation that `sysio.opreg`'s
 * termination window is validated against.
 */
export const DefaultBatchOperatorGroupCount = 3
/**
 * Floor for the derived group SIZE — the depot rejects a zero size, so a group
 * COUNT wider than the roster still derives one-member groups (and then fails
 * the fits-the-roster rule with the flags named).
 */
export const MinimumOperatorsPerEpoch = 1
/**
 * Depot ceilings, mirrored from `sysio.epoch.hpp` so an over-large topology
 * fails HERE instead of inside `sysio.epoch::setconfig` after the whole cluster
 * has been stood up. Keep in lock-step with the contract.
 */
export const MaxOperatorsPerEpoch = 100
export const MaxBatchOperatorGroups = 255
export const MaxScheduledBatchOperators = 1000
/**
 * HARNESS ceiling on the roster — not a depot limit.
 * `Constants.batchOperatorLabel` names operators `batchop.<letter>` off a
 * 26-letter alphabet and wraps modulo its length, so index 26 would collide with
 * index 0: two operators would share one WIRE account, parallel provisioning
 * would try to create it twice, and their node/key config would reuse a single
 * identity. The depot itself would accept a larger roster (`27 = 9 x 3` is a
 * legal shape), so raising this means giving `batchOperatorLabel` a unique
 * suffix past 26 first — the way `producerName` already does.
 */
export const MaxBatchOperatorRoster = 26

/**
 * A whole, positive count — the shape of every `uint32` the depot's
 * `epoch::setconfig` requires to be `> 0`.
 *
 * @param field - Flag name to quote in the message.
 * @returns The schema for that field.
 */
function positiveCountSchema(field: string) {
  return z.number().refine(value => Number.isInteger(value) && value > 0, {
    message: `${field} must be a positive whole number`
  })
}

/**
 * Caller-facing schedule inputs: the roster plus either half of an explicit
 * shape. Single-field ceilings live here so an out-of-range flag is rejected on
 * its own field path instead of surfacing as a downstream arithmetic failure.
 */
export const BatchOperatorScheduleOptionsSchema = z.object({
  batchOperatorCount: positiveCountSchema("batch-operator-count").refine(value => value <= MaxBatchOperatorRoster, {
    message:
      `batch-operator-count exceeds the harness ceiling of ${MaxBatchOperatorRoster} — ` +
      `operator accounts are named batchop.<letter> off a ${MaxBatchOperatorRoster}-letter ` +
      `alphabet, so a larger roster would reuse identities`
  }),
  operatorsPerEpoch: positiveCountSchema("operators-per-epoch")
    .refine(value => value <= MaxOperatorsPerEpoch, {
      message: `operators-per-epoch exceeds the depot ceiling of ${MaxOperatorsPerEpoch}`
    })
    // `nullish`, not `optional`: the persisted `ClusterConfig` stores an unset
    // override as NULL (it must survive the JSON round-trip), and callers pass
    // that value straight through.
    .nullish(),
  batchOpGroups: positiveCountSchema("batch-op-groups")
    .refine(value => value <= MaxBatchOperatorGroups, {
      message: `batch-op-groups exceeds the depot ceiling of ${MaxBatchOperatorGroups}`
    })
    .nullish()
})

/** Caller-facing schedule inputs — the schema-inferred shape. */
export type BatchOperatorScheduleOptions = z.infer<typeof BatchOperatorScheduleOptionsSchema>

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
function deriveOperatorsPerEpoch(batchOperatorCount: number, batchOpGroups: number): number {
  const fits = Math.floor(batchOperatorCount / batchOpGroups),
    odd = fits % 2 === 0 ? fits - 1 : fits
  return Math.max(MinimumOperatorsPerEpoch, odd)
}

/**
 * The depot's batch-operator sliding-window schedule, DERIVED from the options
 * and cross-validated in the same pass. The spec:
 *
 * ```
 * groups = 3
 * assert(group_size % 2 == 1)
 * total  = groups * group_size
 * ```
 *
 * On the DERIVED path (the caller states NEITHER half) that admits exactly the
 * ODD multiples of 3 — `3, 9, 15, 21` — because `count / 3` must be a whole ODD
 * number for `total` to equal the roster. An explicit size or group count takes
 * the caller off that lattice and onto what the depot actually enforces
 * (`total <= roster`), so `{ count: 6, operatorsPerEpoch: 1, batchOpGroups: 3 }`
 * is legal.
 *
 * Cross-field rules live in the transform because each needs the whole resolved
 * triple; single-field ceilings stay on
 * {@link BatchOperatorScheduleOptionsSchema}.
 */
export const BatchOperatorScheduleSchema = BatchOperatorScheduleOptionsSchema.transform((options, ctx) => {
  const { batchOperatorCount, operatorsPerEpoch, batchOpGroups } = options,
    groups = batchOpGroups ?? DefaultBatchOperatorGroupCount,
    // DERIVED = NEITHER half stated. An explicit group COUNT takes the caller
    // off the `groups = 3` lattice just as an explicit size does.
    isDerived = operatorsPerEpoch == null && batchOpGroups == null,
    size = operatorsPerEpoch ?? deriveOperatorsPerEpoch(batchOperatorCount, groups),
    total = size * groups

  if (size % 2 !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["operatorsPerEpoch"],
      message:
        `batch-op group SIZE must be ODD — got operators-per-epoch ${size} ` +
        `(an even group has no strict majority, so the depot's path-2 consensus threshold is undefined)`
    })
  }
  if (total > MaxScheduledBatchOperators) {
    ctx.addIssue({
      code: "custom",
      path: ["batchOperatorMinimumActive"],
      message: `batch_operator_minimum_active ${total} exceeds the depot ceiling of ` + `${MaxScheduledBatchOperators}`
    })
  }
  // DERIVED path: the default shape is exact, so the roster must sit on the
  // lattice. Checked before the generic fits rule so the actionable message
  // wins for an off-lattice roster.
  if (isDerived && total !== batchOperatorCount) {
    ctx.addIssue({
      code: "custom",
      path: ["batchOperatorCount"],
      message:
        `batch-operator-count must be ODD and divisible by ${DefaultBatchOperatorGroupCount} ` +
        `(3, 9, 15, 21) — got ${batchOperatorCount}; ` +
        `pass --operators-per-epoch OR --batch-op-groups to state a shape explicitly`
    })
  } else if (total > batchOperatorCount) {
    // What `schbatchgps` actually asserts: the ACTIVE pool must fill the
    // initial window, and every bootstrapped operator is ACTIVE on
    // registration — so the roster size IS the available pool.
    ctx.addIssue({
      code: "custom",
      path: ["batchOperatorCount"],
      message:
        `batch-operator group shape needs ${total} ACTIVE batch operators ` +
        `(operators-per-epoch ${size} × batch-op-groups ${groups}) ` +
        `but batch-operator-count is ${batchOperatorCount} — raise --batch-operator-count ` +
        `or lower --operators-per-epoch / --batch-op-groups`
    })
  }

  return {
    operatorsPerEpoch: size,
    batchOpGroups: groups,
    batchOperatorMinimumActive: total
  }
})

/**
 * The resolved schedule: group SIZE (`operators_per_epoch`), group COUNT
 * (`batch_op_groups`), and the scheduled total
 * (`batch_operator_minimum_active`) that `sysio.epoch::schbatchgps` requires the
 * ACTIVE roster to cover. Schema-inferred — never hand-declared.
 */
export type BatchOperatorSchedule = z.infer<typeof BatchOperatorScheduleSchema>

export namespace BatchOperatorSchedule {
  /**
   * Resolve + validate the schedule, throwing a {@link NestedError} that
   * PRESERVES the `ZodError` (its issue tree and stack survive) with one
   * `path: message` line per issue — the same shape `SchemaCodec` produces.
   *
   * Called by `ClusterConfigProvider.resolve` before any port is claimed AND by
   * `ClusterBuildDefaults.epochConfig` when building the `epoch::setconfig`
   * payload, so the CLI/flow boundary and the step can never disagree.
   *
   * @param options - The roster plus any explicit shape overrides.
   * @returns The validated schedule.
   * @throws NestedError when a depot or harness invariant would be violated.
   */
  export function resolve(options: BatchOperatorScheduleOptions): BatchOperatorSchedule {
    const result = BatchOperatorScheduleSchema.safeParse(options)
    // safeParse rides `Either`, never a bare `if (result.success)`; the Left is
    // only ever thrown, so `.ifLeft(throw).getOrThrow()`.
    return (
      result.success
        ? Either.right<z.ZodError, BatchOperatorSchedule>(result.data)
        : Either.left<z.ZodError, BatchOperatorSchedule>(result.error)
    )
      .ifLeft(error => {
        const detail = error.issues
          .map(issue => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
          .join("; ")
        throw new NestedError(`batch-operator schedule is invalid — ${detail}`, { cause: error, context: { options } })
      })
      .getOrThrow()
  }
}
