import { currentDateStamp } from "@wireio/debugging-client-tool-tui/features/process-monitor/util/dateStamp.js"

describe("currentDateStamp", () => {
  it("renders YYYYMMDD, zero-padding month and day", () => {
    expect(currentDateStamp(new Date(2026, 0, 1))).toBe("20260101")
    expect(currentDateStamp(new Date(2026, 11, 31))).toBe("20261231")
  })

  it("matches harness ProcessManager convention exactly for 2-digit year boundary", () => {
    expect(currentDateStamp(new Date(1999, 8, 9))).toBe("19990909")
  })
})
