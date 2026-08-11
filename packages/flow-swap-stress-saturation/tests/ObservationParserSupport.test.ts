import {
  hasExactObservationKeys,
  isObservationCount,
  isObservationDecimal,
  isObservationRecord,
  isObservationString,
  isOrderedDecimalWindow,
  observationValuesEqual
} from "@wireio/test-flow-swap-stress-saturation/observation-parsing/index.js"

describe("observation parser support", () => {
  it("isObservationRecord accepts a plain object, rejects arrays and null", () => {
    expect(isObservationRecord({})).toBe(true)
    expect(isObservationRecord([])).toBe(false)
    expect(isObservationRecord(null)).toBe(false)
  })

  it("hasExactObservationKeys requires exactly the allowed keys", () => {
    expect(hasExactObservationKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true)
    expect(hasExactObservationKeys({ a: 1 }, ["a", "b"])).toBe(false)
    expect(hasExactObservationKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false)
  })

  it("isObservationString accepts non-empty text only", () => {
    expect(isObservationString("x")).toBe(true)
    expect(isObservationString("")).toBe(false)
    expect(isObservationString(1)).toBe(false)
  })

  it("isObservationCount accepts non-negative safe integers only", () => {
    expect(isObservationCount(0)).toBe(true)
    expect(isObservationCount(-1)).toBe(false)
    expect(isObservationCount(1.5)).toBe(false)
  })

  it("isObservationDecimal accepts canonical non-negative decimal strings", () => {
    expect(isObservationDecimal("0")).toBe(true)
    expect(isObservationDecimal("123")).toBe(true)
    expect(isObservationDecimal("01")).toBe(false)
    expect(isObservationDecimal("-1")).toBe(false)
  })

  it("observationValuesEqual compares by canonical serialization", () => {
    expect(observationValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(observationValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("isOrderedDecimalWindow requires ordered canonical bounds", () => {
    expect(isOrderedDecimalWindow("1", "2")).toBe(true)
    expect(isOrderedDecimalWindow("2", "1")).toBe(false)
    expect(isOrderedDecimalWindow("x", "2")).toBe(false)
  })
})
