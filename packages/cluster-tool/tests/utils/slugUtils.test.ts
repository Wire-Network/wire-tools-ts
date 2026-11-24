import { SlugName } from "@wireio/sdk-core"

import {
  isCode,
  isPackedCode,
  packedSlugValue,
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

  describe("packedSlugValue", () => {
    // OperatorAction.chain_code / reserve_code are `uint64` in the proto, so
    // they render as a number — or as a QUOTED DECIMAL once past 0xffffffff,
    // which every real chain code is. Routing those through slugValue would
    // read the decimal as a slug spelling and throw.
    it("passes a bare number through", () => {
      expect(packedSlugValue(23373212024832)).toBe(23373212024832)
    })
    it("reads the quoted decimal fc::json emits above 0xffffffff", () => {
      const packed = SlugName.from("ETH")
      expect(packed).toBeGreaterThan(0xffffffff)
      expect(packedSlugValue(String(packed))).toBe(packed)
    })
    it("rejects anything but a number or an unsigned decimal", () => {
      expect(() => packedSlugValue("ETH")).toThrow(/unsigned decimal/)
      expect(() => packedSlugValue("-1")).toThrow(/unsigned decimal/)
      expect(() => packedSlugValue(null)).toThrow(
        /unrecognised packed code carrier/
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
    it("refuses a digit-leading string, so a decimal is never read as a slug", () => {
      // A code must start with a letter, which is what makes the bare-string
      // carrier unambiguous: no legal spelling can also be read as a number, so
      // neither a decimal nor JS numeric syntax can collide with a code.
      const leadingLetter = /must start with a letter/
      expect(() => slugValue("7")).toThrow(leadingLetter)
      expect(() => slugValue("101")).toThrow(leadingLetter)
      expect(() => slugValue("1E3")).toThrow(leadingLetter)
      expect(() => slugValue("0X10")).toThrow(leadingLetter)
    })
    it("reads digits after the leading letter as part of the code", () => {
      expect(slugValue("Z1234567")).toBe(SlugName.from("Z1234567"))
      expect(slugValue("V1")).toBe(SlugName.from("V1"))
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

  describe("isCode", () => {
    it("matches a slug_name cell against a codename", () => {
      expect(isCode("SOLANA", "SOLANA")).toBe(true)
      expect(isCode("LIQSOL", "LIQSOL")).toBe(true)
      expect(isCode("SOLANA", "ETHEREUM")).toBe(false)
    })
    it("never reads a slug spelling as a packed decimal", () => {
      // A slug cell is a spelling: the packed value of SOLANA, spelled as digits, is not
      // a valid slug, so it can never match the codename.
      expect(() => isCode(String(SlugName.from("SOLANA")), "SOLANA")).toThrow()
    })
    it("throws on a cell that is no slug rather than matching nothing", () => {
      expect(() => isCode("not a slug!", "SOLANA")).toThrow()
    })
  })

  describe("isPackedCode", () => {
    it("matches a packed uint64 cell, numeric or quoted, against a codename", () => {
      expect(isPackedCode(SlugName.from("ETHEREUM"), "ETHEREUM")).toBe(true)
      expect(isPackedCode(String(SlugName.from("ETHEREUM")), "ETHEREUM")).toBe(true)
      expect(isPackedCode(SlugName.from("ETHEREUM"), "SOLANA")).toBe(false)
    })
    it("refuses a slug spelling rather than misreading it as a packed value", () => {
      expect(() => isPackedCode("ETHEREUM", "ETHEREUM")).toThrow(/unsigned decimal/)
    })
  })
})
