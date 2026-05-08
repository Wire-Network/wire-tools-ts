import { currentDateStamp } from "@wireio/debugging-shared"

describe("currentDateStamp", () => {
  it("formats as YYYYMMDD with single-digit month/day padded", () => {
    expect(currentDateStamp(new Date(2026, 0, 5))).toBe("20260105")
  })

  it("preserves two-digit month and day verbatim", () => {
    expect(currentDateStamp(new Date(2026, 11, 31))).toBe("20261231")
  })

  it("uses local time, not UTC, so the harness pid dir matches", () => {
    const d = new Date(2026, 4, 8) // May 8, 2026
    expect(currentDateStamp(d)).toBe("20260508")
  })
})
