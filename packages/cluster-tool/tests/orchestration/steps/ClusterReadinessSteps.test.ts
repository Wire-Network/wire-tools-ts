import {
  assessEpochScheduler,
  ClusterReadinessSteps,
  epochOverdueMs,
  EpochSchedulerState,
  observeAdvancement,
  runChainRegistry,
  runEpochScheduler,
  runEthereumHeadAdvancement,
  runEthereumIdentity,
  runHyperionHealth,
  runRequiredEndpoints,
  runSolanaIdentity,
  runSolanaSlotAdvancement,
  runWireContracts,
  runWireHeadAdvancement,
  runWireHeadFreshness,
  runWireIdentity
} from "@wireio/cluster-tool/orchestration/steps/ClusterReadinessSteps"
import { Report } from "@wireio/cluster-tool/report"

describe("ClusterReadinessSteps factories", () => {
  it("wires every planned Step to its named runner and typed input", () => {
    const pairs = [
      [ClusterReadinessSteps.planRequiredEndpoints, runRequiredEndpoints],
      [ClusterReadinessSteps.planWireIdentity, runWireIdentity],
      [ClusterReadinessSteps.planWireHeadAdvancement, runWireHeadAdvancement],
      [ClusterReadinessSteps.planWireHeadFreshness, runWireHeadFreshness],
      [ClusterReadinessSteps.planEthereumIdentity, runEthereumIdentity],
      [
        ClusterReadinessSteps.planEthereumHeadAdvancement,
        runEthereumHeadAdvancement
      ],
      [ClusterReadinessSteps.planSolanaIdentity, runSolanaIdentity],
      [
        ClusterReadinessSteps.planSolanaSlotAdvancement,
        runSolanaSlotAdvancement
      ],
      [ClusterReadinessSteps.planHyperionHealth, runHyperionHealth],
      [ClusterReadinessSteps.planWireContracts, runWireContracts],
      [ClusterReadinessSteps.planEpochScheduler, runEpochScheduler],
      [ClusterReadinessSteps.planChainRegistry, runChainRegistry]
    ] as const
    pairs.forEach(([planner, runner], index) => {
      const step = planner(Report.Actor.Sysio, `step-${index}`, "fixture", {
        timeoutMs: 123
      })
      expect(step.runner).toBe(runner)
      expect(step.input).toEqual({ kind: "ClusterReadinessSteps.Input" })
      expect(step.options.timeoutMs).toBe(123)
    })
  })
})

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

  it("rejects invalid scheduler inputs without manufacturing progress", () => {
    const assessment = assessEpochScheduler(1, "not-a-time", 0, [], 1_000)
    expect(assessment.state).toBe(EpochSchedulerState.stalledOrUnproven)
    expect(assessment.progressing).toBe(false)
    expect(epochOverdueMs("not-a-time", 1_000)).toBeNaN()
  })

  it("observes monotonic advancement and rejects a stalled value", async () => {
    const advancing = jest.fn().mockResolvedValueOnce(7).mockResolvedValue(8)
    await expect(
      observeAdvancement("fixture", advancing, 5, new AbortController().signal)
    ).resolves.toEqual({ initial: 7, followUp: 8 })
    await expect(
      observeAdvancement(
        "fixture",
        async () => 7,
        1,
        new AbortController().signal
      )
    ).rejects.toThrow("fixture did not advance")
  })
})
