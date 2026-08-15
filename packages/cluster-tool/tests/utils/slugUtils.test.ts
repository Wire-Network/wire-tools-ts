import {
  slugValue,
  tokenCodeToLittleEndianBuffer
} from "@wireio/cluster-tool/utils"

describe("slugUtils", () => {
  describe("tokenCodeToLittleEndianBuffer", () => {
    it("encodes the full u64 range as 8 little-endian bytes", () => {
      const maxU64 = 2n ** 64n - 1n
      expect([...tokenCodeToLittleEndianBuffer(maxU64)]).toEqual([
        255, 255, 255, 255, 255, 255, 255, 255
      ])
      expect(tokenCodeToLittleEndianBuffer(0n).readBigUInt64LE()).toBe(0n)
      expect([...tokenCodeToLittleEndianBuffer(256n)]).toEqual([
        0, 1, 0, 0, 0, 0, 0, 0
      ])
    })

    it("rejects a value that does not fit in a u64", () => {
      expect(() => tokenCodeToLittleEndianBuffer(2n ** 64n)).toThrow()
    })

    it("is deterministic", () => {
      expect(tokenCodeToLittleEndianBuffer(123_456_789n)).toEqual(
        tokenCodeToLittleEndianBuffer(123_456_789n)
      )
    })
  })

  describe("slugValue", () => {
    it("passes a bare number through", () => {
      expect(slugValue(23373300651341)).toBe(23373300651341)
    })
    it("parses a numeric string", () => {
      expect(slugValue("84606581215232")).toBe(84606581215232)
    })
    it("unwraps the generated { value: number } slug wrapper", () => {
      expect(slugValue({ value: 42 })).toBe(42)
    })
    it("unwraps a { value: string } wrapper", () => {
      expect(slugValue({ value: "1234" })).toBe(1234)
    })
    it("returns NaN for unrecognised shapes", () => {
      expect(slugValue(null)).toBeNaN()
      expect(slugValue({ other: 1 })).toBeNaN()
      expect(slugValue([1])).toBeNaN()
    })
  })
})
