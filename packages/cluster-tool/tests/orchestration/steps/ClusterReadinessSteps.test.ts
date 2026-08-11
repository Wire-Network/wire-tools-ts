import { epochOverdueMs } from "@wireio/cluster-tool/orchestration/steps/ClusterReadinessSteps"

describe("ClusterReadinessSteps", () => {
  it("measures an overdue Wire epoch from its UTC-implicit timestamp", () => {
    expect(
      epochOverdueMs(
        "2026-08-11T14:06:09.000",
        Date.parse("2026-08-11T14:08:09.000Z")
      )
    ).toBe(120_000)
  })

  it("returns zero before the scheduled epoch boundary", () => {
    expect(
      epochOverdueMs(
        "2026-08-11T14:06:09.000Z",
        Date.parse("2026-08-11T14:05:09.000Z")
      )
    ).toBe(0)
  })

  it("returns NaN for an invalid epoch timestamp", () => {
    expect(epochOverdueMs("not-a-timestamp", 0)).toBeNaN()
  })
})
