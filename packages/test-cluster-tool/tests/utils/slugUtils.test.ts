import { slugValue } from "@wireio/test-cluster-tool/utils"

describe("slugUtils", () => {
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
