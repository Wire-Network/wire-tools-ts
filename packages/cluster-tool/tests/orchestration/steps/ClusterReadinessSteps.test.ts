import {
  assessEpochScheduler,
  epochOverdueMs,
  EpochSchedulerState
} from "@wireio/cluster-tool/orchestration/steps/ClusterReadinessSteps"

describe("ClusterReadinessSteps epoch assessment", () => {
  it("allows the protocol extension window", () => {
    const assessment = assessEpochScheduler(
      50,
      "2026-08-11T20:00:00.000",
      60,
      [],
      Date.parse("2026-08-11T20:00:20.000Z")
    )
    expect(assessment).toMatchObject({
      state: EpochSchedulerState.onTime,
      overdueMs: 20_000,
      progressing: false
    })
  })

  it("separates recent catch-up progress from a hard stall", () => {
    const assessment = assessEpochScheduler(
      55,
      "2026-08-11T20:48:00.000",
      60,
      [
        { epochIndex: 55, emittedAt: "2026-08-11T20:50:15.500" },
        { epochIndex: 54, emittedAt: "2026-08-11T20:49:15.500" }
      ],
      Date.parse("2026-08-11T20:50:30.000Z")
    )
    expect(assessment).toMatchObject({
      state: EpochSchedulerState.advancingLate,
      progressing: true,
      latestProgressEpoch: 55,
      previousProgressEpoch: 54
    })
  })

  it("does not infer progress from stale samples", () => {
    const assessment = assessEpochScheduler(
      55,
      "2026-08-11T20:48:00.000",
      60,
      [
        { epochIndex: 54, emittedAt: "2026-08-11T20:40:00.000" },
        { epochIndex: 53, emittedAt: "2026-08-11T20:39:00.000" }
      ],
      Date.parse("2026-08-11T20:50:30.000Z")
    )
    expect(assessment.state).toBe(EpochSchedulerState.stalledOrUnproven)
  })

  it("parses UTC-implicit Wire timestamps", () => {
    expect(
      epochOverdueMs(
        "2026-08-11T14:06:09.000",
        Date.parse("2026-08-11T14:08:09.000Z")
      )
    ).toBe(120_000)
  })
})
