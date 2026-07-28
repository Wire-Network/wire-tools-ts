import { BatchOperatorSchedule } from "@wireio/cluster-tool/config"

/**
 * The ONE place the batch-operator schedule is derived + validated, shared by
 * `ClusterConfigProvider.resolve` (fail-fast, before any port is claimed) and
 * `ClusterBuildDefaults.epochConfig` (the `epoch::setconfig` payload). Pure, so
 * every case here runs without a cluster.
 */
describe("BatchOperatorSchedule.resolve", () => {
  const { resolve } = BatchOperatorSchedule

  describe("derived shape (no overrides)", () => {
    // groups = 3; assert(size % 2 == 1); total = groups * size — which admits
    // exactly the ODD multiples of 3, where total lands ON the roster.
    it.each([
      [3, 1],
      [9, 3],
      [15, 5],
      [21, 7],
      [27, 9],
      [63, 21]
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
        /pass --operators-per-epoch \/ --batch-op-groups to state a shape explicitly/
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
    it.each([0, -1, 2.5, Number.NaN])(
      "rejects a group count of %p",
      groups => {
        expect(() => resolve(21, undefined, groups)).toThrow(
          /batch-op-groups must be a positive whole number/
        )
      }
    )

    it.each([0, -3, 1.5])("rejects a group size of %p", size => {
      expect(() => resolve(21, size)).toThrow(
        /operators-per-epoch must be a positive whole number/
      )
    })

    it.each([0, -9, 2.5])("rejects a roster of %p", roster => {
      expect(() => resolve(roster)).toThrow(
        /batch-operator-count must be a positive whole number/
      )
    })
  })

  describe("depot ceilings (sysio.epoch.hpp)", () => {
    // Review finding: these used to pass here and fail inside
    // `sysio.epoch::setconfig` after the whole cluster had been stood up.
    it("rejects a DERIVED size past MAX_OPERATORS_PER_EPOCH (100)", () => {
      // 303 / 3 = 101 — one past the contract cap.
      expect(() => resolve(303)).toThrow(
        /operators-per-epoch 101 exceeds the depot ceiling of 100/
      )
    })

    it("rejects an explicit size past MAX_OPERATORS_PER_EPOCH", () => {
      expect(() => resolve(100_000, 101, 1)).toThrow(
        /exceeds the depot ceiling of 100/
      )
    })

    it("rejects a group count past MAX_BATCH_OP_GROUPS (255)", () => {
      expect(() => resolve(100_000, 1, 256)).toThrow(
        /batch-op-groups 256 exceeds the depot ceiling of 255/
      )
    })

    it("rejects a scheduled total past MAX_SCHEDULED_BATCH_OPERATORS (1000)", () => {
      // 99 x 255 = 25245 — under both per-field caps, over the total cap.
      expect(() => resolve(100_000, 99, 255)).toThrow(
        /batch_operator_minimum_active 25245 exceeds the depot ceiling of 1000/
      )
    })

    it("accepts the largest legal derived roster", () => {
      // 297 / 3 = 99 (odd, ≤ 100); total 297 ≤ 1000.
      expect(resolve(297)).toMatchObject({
        operatorsPerEpoch: 99,
        batchOperatorMinimumActive: 297
      })
    })

    it("pins the ceilings against the contract", () => {
      expect(BatchOperatorSchedule.MaxOperatorsPerEpoch).toBe(100)
      expect(BatchOperatorSchedule.MaxBatchOperatorGroups).toBe(255)
      expect(BatchOperatorSchedule.MaxScheduledBatchOperators).toBe(1000)
      expect(BatchOperatorSchedule.DefaultBatchOperatorGroupCount).toBe(3)
    })
  })
})
