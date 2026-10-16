import { compareBigInt } from "@wireio/cluster-tool/utils"

describe("compareBigInt", () => {
  it("orders bigints, including ones no number can hold", () => {
    expect(compareBigInt(1n, 2n)).toBe(-1)
    expect(compareBigInt(2n, 1n)).toBe(1)
    expect(compareBigInt(3n, 3n)).toBe(0)
    const huge = 2n ** 80n
    expect([huge + 1n, 0n, huge].sort(compareBigInt)).toEqual([
      0n,
      huge,
      huge + 1n
    ])
  })
})
