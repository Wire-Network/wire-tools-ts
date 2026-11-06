import { compareBigInt, isqrt } from "@wireio/cluster-tool/utils"

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

describe("isqrt", () => {
  it("floors the square root, exactly beyond a double's precision", () => {
    expect([0n, 1n, 2n, 3n, 4n, 6n, 8n, 9n].map(isqrt)).toEqual([
      0n,
      1n,
      1n,
      1n,
      2n,
      2n,
      2n,
      3n
    ])
    const root = 10n ** 18n + 7n
    expect(isqrt(root * root)).toBe(root)
    expect(isqrt(root * root - 1n)).toBe(root - 1n)
  })

  it("refuses a negative value", () => {
    expect(() => isqrt(-1n)).toThrow(/negative/)
  })
})
