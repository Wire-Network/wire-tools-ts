import { OperatorStatus } from "@wireio/opp-typescript-models"
import {
  inRange,
  isNotEmpty,
  matchesProtoEnum
} from "@wireio/cluster-tool/utils"

describe("predicateUtils", () => {
  describe("isNotEmpty", () => {
    it("is false for every empty shape", () => {
      expect(isNotEmpty("")).toBe(false)
      expect(isNotEmpty([])).toBe(false)
      expect(isNotEmpty({})).toBe(false)
      expect(isNotEmpty(null)).toBe(false)
      expect(isNotEmpty(undefined)).toBe(false)
    })
    it("is true for non-empty values", () => {
      expect(isNotEmpty("x")).toBe(true)
      expect(isNotEmpty([1])).toBe(true)
      expect(isNotEmpty({ a: 1 })).toBe(true)
    })
  })

  describe("inRange", () => {
    it("is inclusive on both bounds", () => {
      expect(inRange(5, 1, 10)).toBe(true)
      expect(inRange(1, 1, 10)).toBe(true)
      expect(inRange(10, 1, 10)).toBe(true)
    })
    it("rejects values outside the range", () => {
      expect(inRange(0, 1, 10)).toBe(false)
      expect(inRange(11, 1, 10)).toBe(false)
    })
    it("defaults the max to the safe-integer ceiling", () => {
      expect(inRange(1e15, 1)).toBe(true)
    })
  })

  describe("matchesProtoEnum", () => {
    // Use the real proto enum (never a hand-rolled `{ NAME: value }` table).
    const want = OperatorStatus.ACTIVE
    const spelling = OperatorStatus[want] // the enum's own reverse-mapped name

    it("matches numeric, numeric-string, and the enum's spelling", () => {
      expect(matchesProtoEnum(want, OperatorStatus, want)).toBe(true)
      expect(matchesProtoEnum(String(want), OperatorStatus, want)).toBe(true)
      expect(matchesProtoEnum(spelling, OperatorStatus, want)).toBe(true)
    })
    it("rejects a different member and non-string/number shapes", () => {
      expect(
        matchesProtoEnum(OperatorStatus.TERMINATED, OperatorStatus, want)
      ).toBe(false)
      expect(matchesProtoEnum("NOPE", OperatorStatus, want)).toBe(false)
      expect(matchesProtoEnum(null, OperatorStatus, want)).toBe(false)
      expect(matchesProtoEnum({}, OperatorStatus, want)).toBe(false)
    })
  })
})
