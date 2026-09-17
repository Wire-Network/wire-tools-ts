import { SlugName } from "@wireio/sdk-core"

import {
  slugValue,
  slugNameToLittleEndianBuffer
} from "@wireio/cluster-tool/utils"

describe("slugUtils", () => {
  describe("slugNameToLittleEndianBuffer", () => {
    it("encodes the full u64 range as 8 little-endian bytes", () => {
      const maxU64 = 2n ** 64n - 1n
      expect([...slugNameToLittleEndianBuffer(maxU64)]).toEqual([
        255, 255, 255, 255, 255, 255, 255, 255
      ])
      expect(slugNameToLittleEndianBuffer(0n).readBigUInt64LE()).toBe(0n)
      expect([...slugNameToLittleEndianBuffer(256n)]).toEqual([
        0, 1, 0, 0, 0, 0, 0, 0
      ])
    })

    it("rejects a value that does not fit in a u64", () => {
      expect(() => slugNameToLittleEndianBuffer(2n ** 64n)).toThrow()
    })

    it("is deterministic", () => {
      expect(slugNameToLittleEndianBuffer(123_456_789n)).toEqual(
        slugNameToLittleEndianBuffer(123_456_789n)
      )
    })

    // Both carriers occur: SlugName.from() / slugValue() yield `number`, while
    // the generated deposit + swap inputs carry the u64 as `bigint`. Widening
    // here is what keeps `BigInt(...)` out of every call site.
    it("accepts the number carrier identically to the bigint one", () => {
      expect(slugNameToLittleEndianBuffer(256)).toEqual(
        slugNameToLittleEndianBuffer(256n)
      )
      // A slug_name packs into 48 bits, so the whole domain is number-safe.
      const maxSlugName = 2 ** 48 - 1
      expect(slugNameToLittleEndianBuffer(maxSlugName).readBigUInt64LE()).toBe(
        BigInt(maxSlugName)
      )
    })
  })

  describe("slugValue", () => {
    it("passes a bare number through", () => {
      expect(slugValue(23373300651341)).toBe(23373300651341)
    })
    it("parses a bare string as a slug, never as a decimal", () => {
      expect(slugValue("ETHEREUM")).toBe(SlugName.from("ETHEREUM"))
      expect(slugValue("WIRE")).toBe(SlugName.from("WIRE"))
    })
    it("reads a digit-only code as the slug it is", () => {
      // The slug alphabet contains digits, so these are real codes whose packed
      // values are nothing like their decimal readings. The previous decoder
      // preferred the decimal and mis-decoded every one of them.
      expect(slugValue("7")).toBe(SlugName.from("7"))
      expect(slugValue("7")).not.toBe(7)
      expect(slugValue("101")).toBe(SlugName.from("101"))
      expect(slugValue("101")).not.toBe(101)
    })
    it("does not let JS numeric syntax reinterpret a code", () => {
      expect(slugValue("1E3")).toBe(SlugName.from("1E3"))
      expect(slugValue("1E3")).not.toBe(1000)
      expect(slugValue("0X10")).toBe(SlugName.from("0X10"))
      expect(slugValue("0X10")).not.toBe(16)
    })
    it("reads the empty spelling as the zero sentinel", () => {
      expect(slugValue("")).toBe(0)
    })
    it("rejects a bare string that is not a valid slug", () => {
      // The top-level decimal carrier no longer exists: a slug is at most 8
      // symbols, so a packed spelling is simply an invalid code.
      expect(() => slugValue("84606581215232")).toThrow()
      expect(() => slugValue("eth")).toThrow()
    })
    it("unwraps the generated { value: number } slug wrapper", () => {
      expect(slugValue({ value: 42 })).toBe(42)
    })
    it("reads a { value: string } wrapper as the packed decimal it holds", () => {
      // The wrapper carries a packed u64; fc::json quotes one above 0xffffffff.
      expect(slugValue({ value: "1234" })).toBe(1234)
      expect(slugValue({ value: String(SlugName.from("ETH")) })).toBe(
        SlugName.from("ETH")
      )
    })
    it("rejects a { value } wrapper holding anything but an unsigned decimal", () => {
      // Mirrors the depot's checked_packed_value: Number() would coerce these to
      // NaN or truncate them instead of refusing them.
      expect(() => slugValue({ value: "ETH" })).toThrow(/unsigned decimal/)
      expect(() => slugValue({ value: "-1" })).toThrow(/unsigned decimal/)
      expect(() => slugValue({ value: "1.5" })).toThrow(/unsigned decimal/)
      expect(() => slugValue({ value: "" })).toThrow(/unsigned decimal/)
    })
    it("throws on unrecognised shapes rather than returning NaN", () => {
      // NaN never equals itself, so a NaN slug silently matches zero rows in a
      // filter predicate and surfaces minutes later as a poll timeout.
      expect(() => slugValue(null)).toThrow(/unrecognised slug carrier/)
      expect(() => slugValue({ other: 1 })).toThrow(/unrecognised slug carrier/)
      expect(() => slugValue([1])).toThrow(/unrecognised slug carrier/)
    })
  })
})
