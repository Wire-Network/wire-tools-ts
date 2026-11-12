import {
  SupermajorityDenominator,
  SupermajorityNumerator,
  supermajorityThreshold
} from "@wireio/cluster-tool/utils"

describe("quorumUtils", () => {
  it("is a two-thirds fraction", () => {
    expect(SupermajorityNumerator / SupermajorityDenominator).toBeCloseTo(2 / 3)
  })

  describe("supermajorityThreshold", () => {
    it.each([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 3],
      [5, 4],
      [6, 5],
      [21, 15]
    ])("is floor(2N/3)+1 for %p members → %p", (members, threshold) => {
      expect(supermajorityThreshold(members)).toBe(threshold)
    })

    it("always exceeds two thirds of the members and never needs more than all of them", () => {
      Array.from({ length: 30 }, (_, index) => index + 1).forEach(members => {
        const threshold = supermajorityThreshold(members)
        expect(threshold * SupermajorityDenominator).toBeGreaterThan(
          members * SupermajorityNumerator
        )
        expect(threshold).toBeLessThanOrEqual(members)
      })
    })
  })
})
