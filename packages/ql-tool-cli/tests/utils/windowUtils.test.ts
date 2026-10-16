import { formatWindowText, isWindowMember, NoLimitText, parseWindowText } from "@wireio/ql-tool-cli/utils/index.js"

describe("windowUtils", () => {
  it("accepts non-negative integers only", () => {
    expect([0, 7].map(isWindowMember)).toEqual([true, true])
    expect([-1, 1.5, Number.NaN].map(isWindowMember)).toEqual([false, false, false])
  })

  it("parses offset[,limit] into Right; empty clears (Right null)", () => {
    expect(parseWindowText("").getOrThrow()).toBeNull()
    expect(parseWindowText("   ").getOrThrow()).toBeNull()
    expect(parseWindowText(" 10 , 5 ").getOrThrow()).toEqual({ offset: 10, limit: 5 })
    expect(parseWindowText("3").getOrThrow()).toEqual({ offset: 3, limit: null })
    expect(parseWindowText("3,").getOrThrow()).toEqual({ offset: 3, limit: null })
  })

  it("rejects negative, fractional, missing-offset and three-member windows as Left (the text)", () => {
    ;["-1,2", ",2", "1.5", "1,2,3", "a,b"].forEach(text => {
      const parsed = parseWindowText(text)
      expect(parsed.isLeft()).toBe(true)
      expect(parsed.getLeftOrThrow()).toBe(text)
    })
  })

  it("names the absent limit with NoLimitText", () => {
    expect(NoLimitText).toBe("none")
  })

  it("formats a window back to text", () => {
    expect(formatWindowText(null)).toBe("")
    expect(formatWindowText({ offset: 10, limit: 5 })).toBe("10,5")
    expect(formatWindowText({ offset: 3, limit: null })).toBe("3,")
    expect(parseWindowText(formatWindowText({ offset: 4, limit: 2 })).getOrThrow()).toEqual({ offset: 4, limit: 2 })
  })
})
