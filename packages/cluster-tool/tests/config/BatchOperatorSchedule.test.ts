import { z } from "zod"
import {
  BatchOperatorSchedule,
  BatchOperatorScheduleOptionsSchema,
  BatchOperatorScheduleSchema,
  DefaultBatchOperatorGroupCount,
  MaxBatchOperatorGroups,
  MaxBatchOperatorRoster,
  MaxOperatorsPerEpoch
} from "@wireio/cluster-tool/config"
// Direct module, not the root barrel (it re-exports FlowCLI → yargs@18, which
// jest cannot require as ESM on Node < 24.9).
import { Constants } from "@wireio/cluster-tool/Constants"

/**
 * The ONE place the batch-operator schedule is derived + validated, shared by
 * `ClusterConfigProvider.resolve` (fail-fast, before any port is claimed) and
 * `ClusterBuildDefaults.epochConfig` (the `epoch::setconfig` payload). Pure, so
 * every case here runs without a cluster.
 */
describe("BatchOperatorSchedule.resolve", () => {
  // The schema takes ONE options object; this keeps the cases readable.
  const resolve = (
    batchOperatorCount: number,
    operatorsPerEpoch?: number,
    batchOpGroups?: number
  ) =>
    BatchOperatorSchedule.resolve({
      batchOperatorCount,
      operatorsPerEpoch,
      batchOpGroups
    })

  describe("derived shape (no overrides)", () => {
    // groups = 3; assert(size % 2 == 1); total = groups * size — which admits
    // exactly the ODD multiples of 3, where total lands ON the roster.
    it.each([
      [3, 1],
      [9, 3],
      [15, 5],
      [21, 7]
    ])("derives an exact odd size for a roster of %i → %i per group", (roster, size) => {
      expect(resolve(roster)).toEqual({
        operatorsPerEpoch: size,
        batchOpGroups: 3,
        batchOperatorMinimumActive: roster
      })
    })

    it.each([1, 4, 5, 6, 7, 20])(
      "rejects a roster of %i off the odd/3-divisible lattice",
      roster => {
        expect(() => resolve(roster)).toThrow(/must be ODD and divisible by 3/)
      }
    )

    it("names the escape hatch in the lattice error", () => {
      expect(() => resolve(20)).toThrow(
        /pass --operators-per-epoch OR --batch-op-groups to state a shape explicitly/
      )
    })
  })

  describe("explicit overrides", () => {
    // Review finding: an explicit shape must be held to what the DEPOT requires
    // (total <= roster), not to the derived-path lattice — a roster of 6 with a
    // 1 x 3 shape is legal and used to be rejected outright.
    it("accepts a legal explicit shape on an off-lattice roster", () => {
      expect(resolve(6, 1, 3)).toEqual({
        operatorsPerEpoch: 1,
        batchOpGroups: 3,
        batchOperatorMinimumActive: 3
      })
    })

    it("accepts a scheduled total smaller than the roster", () => {
      expect(resolve(21, 3, 3).batchOperatorMinimumActive).toBe(9)
    })

    it("rejects an EVEN explicit size", () => {
      expect(() => resolve(21, 4)).toThrow(/group SIZE must be ODD/)
    })

    it("rejects a shape the roster cannot fill, naming both flags", () => {
      expect(() => resolve(21, 7, 5)).toThrow(
        /needs 35 ACTIVE batch operators.*batch-operator-count is 21/s
      )
    })

    it("keeps a derived size ODD when the group COUNT is off the lattice", () => {
      // 21 / 5 = 4.2 → floor 4 → down to 3; 3 x 5 = 15 ≤ 21.
      expect(resolve(21, undefined, 5)).toMatchObject({
        operatorsPerEpoch: 3,
        batchOperatorMinimumActive: 15
      })
    })
  })

  describe("degenerate group counts", () => {
    // Review finding: a zero/negative/fractional COUNT used to slip through —
    // the size clamped to 1 but the count stayed 0, so `epochConfig` emitted
    // batch_op_groups: 0 and the depot rejected it AFTER the cluster was up.
    it.each([0, -1, 2.5])("rejects a group count of %p", groups => {
      expect(() => resolve(21, undefined, groups)).toThrow(
        /batchOpGroups: batch-op-groups must be a positive whole number/
      )
    })

    it("rejects NaN structurally, on its own field path", () => {
      // z.number() rejects NaN before the positive-whole refine runs.
      expect(() => resolve(21, undefined, Number.NaN)).toThrow(
        /batchOpGroups: Invalid input: expected number, received NaN/
      )
    })

    it.each([0, -3, 1.5])("rejects a group size of %p", size => {
      expect(() => resolve(21, size)).toThrow(
        /operatorsPerEpoch: operators-per-epoch must be a positive whole number/
      )
    })

    it.each([0, -9, 2.5])("rejects a roster of %p", roster => {
      expect(() => resolve(roster)).toThrow(
        /batchOperatorCount: batch-operator-count must be a positive whole number/
      )
    })
  })

  describe("depot ceilings (sysio.epoch.hpp)", () => {
    // Review finding: these used to pass here and fail inside
    // `sysio.epoch::setconfig` after the whole cluster had been stood up.
    // The group-size ceiling sits below the harness roster cap, so a DERIVED
    // size is capped at it; an explicit size or group count past its ceiling
    // is rejected on its own field.
    it("rejects an explicit size past MAX_OPERATORS_PER_EPOCH (7)", () => {
      expect(() => resolve(21, 9, 1)).toThrow(
        /operatorsPerEpoch: operators-per-epoch exceeds the depot ceiling of 7/
      )
    })

    it("rejects a group count past MAX_BATCH_OP_GROUPS (8)", () => {
      expect(() => resolve(21, 1, 9)).toThrow(
        /batchOpGroups: batch-op-groups exceeds the depot ceiling of 8/
      )
    })

    it("accepts a size and a group count at their ceilings", () => {
      expect(resolve(21, 7, 3).batchOperatorMinimumActive).toBe(21)
      expect(resolve(24, 3, 8).batchOperatorMinimumActive).toBe(24)
    })

    it.each([
      [1, 7],
      [2, 14]
    ])(
      "caps a size derived over %i group(s) at MAX_OPERATORS_PER_EPOCH",
      (groups, total) => {
        // 21 operators would fill groups of 21 or 10; the rest stay unscheduled.
        expect(resolve(21, undefined, groups)).toEqual({
          operatorsPerEpoch: 7,
          batchOpGroups: groups,
          batchOperatorMinimumActive: total
        })
      }
    )

    it("accepts the largest legal DERIVED roster (21 = 7 x 3)", () => {
      expect(resolve(21)).toMatchObject({
        operatorsPerEpoch: 7,
        batchOperatorMinimumActive: 21
      })
    })

    it("rejects a roster past the harness label space", () => {
      // The depot would take a roster of 27 (it schedules the window and leaves
      // the rest out), but `Constants.batchOperatorLabel` wraps modulo 26, so
      // operator 27 would reuse the `batchop.a` handle.
      expect(() => resolve(27)).toThrow(
        /batchOperatorCount: batch-operator-count exceeds the harness ceiling of 26/
      )
    })

    it("gives every operator in the largest accepted roster a UNIQUE label", () => {
      const max = MaxBatchOperatorRoster
      expect(() => resolve(max, 1, 1)).not.toThrow()
      const names = Array.from({ length: max }, (_, index) =>
        Constants.batchOperatorLabel(index)
      )
      expect(new Set(names).size).toBe(max)
      // One past the cap is exactly where the collision starts.
      expect(Constants.batchOperatorLabel(max)).toBe(
        Constants.batchOperatorLabel(0)
      )
    })

    it("pins the ceilings against the contract", () => {
      expect(MaxOperatorsPerEpoch).toBe(7)
      expect(MaxBatchOperatorGroups).toBe(8)
      expect(DefaultBatchOperatorGroupCount).toBe(3)
      expect(MaxBatchOperatorRoster).toBe(26)
    })
  })

  describe("schema surface", () => {
    // The point of the zod standard: the shape IS the schema, validation is
    // safeParse, and failures carry structured issue PATHS (not just prose).
    it("safeParses a legal shape into the inferred type", () => {
      const result = BatchOperatorScheduleSchema.safeParse({
        batchOperatorCount: 21
      })
      expect(result.success).toBe(true)
      const schedule: BatchOperatorSchedule = result.data
      expect(schedule).toEqual({
        operatorsPerEpoch: 7,
        batchOpGroups: 3,
        batchOperatorMinimumActive: 21
      })
    })

    it("reports cross-field failures on the field they belong to", () => {
      const result = BatchOperatorScheduleSchema.safeParse({
        batchOperatorCount: 21,
        operatorsPerEpoch: 4
      })
      expect(result.success).toBe(false)
      expect(result.error.issues.map(issue => issue.path.join("."))).toContain(
        "operatorsPerEpoch"
      )
    })

    it("rejects a non-numeric input structurally", () => {
      const result = BatchOperatorScheduleOptionsSchema.safeParse({
        batchOperatorCount: "21"
      })
      expect(result.success).toBe(false)
    })

    it("preserves the ZodError as the thrown error's cause", () => {
      // NestedError keeps the issue tree + stack, per nested-error-preserve-cause.
      try {
        BatchOperatorSchedule.resolve({ batchOperatorCount: 20 })
        throw new Error("expected resolve to throw")
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).cause).toBeInstanceOf(z.ZodError)
      }
    })
  })
})
