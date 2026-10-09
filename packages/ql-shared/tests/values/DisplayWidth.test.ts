import { DisplayWidth } from "@wireio/ql-shared"

describe("DisplayWidth", () => {
  it("measures ASCII as its length", () => {
    expect(DisplayWidth.of("alice")).toBe(5)
    expect(DisplayWidth.of("")).toBe(0)
  })

  it("measures CJK as two columns per character", () => {
    expect(DisplayWidth.of("漢字")).toBe(4)
  })

  it("measures combining marks as zero", () => {
    expect(DisplayWidth.of("é")).toBe(1)
  })

  it("falls back to the per-code-point sum on a control character", () => {
    expect(DisplayWidth.of("a\nb")).toBe(2)
  })

  it("sums an emoji ZWJ sequence per code point (documented limitation)", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"
    expect(DisplayWidth.of(family)).toBe(6)
  })
})
