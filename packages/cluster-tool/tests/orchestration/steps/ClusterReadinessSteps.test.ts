import {
  ClusterEpochSchedulerState,
  ClusterReadinessCheckStatus,
  ClusterReadinessFeature,
  ClusterReadinessReasonCode
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Steps } from "@wireio/cluster-tool/orchestration"
import {
  assessEpochScheduler,
  epochOverdueMs
} from "@wireio/cluster-tool/orchestration/steps/ClusterReadinessSteps"
import {
  ReadinessContext,
  ReadinessOutputs
} from "@wireio/cluster-tool/readiness"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const EpochConfig: SysioContracts.SysioEpochEpochConfigType = {
  epoch_duration_sec: 60,
  operators_per_epoch: 21,
  batch_operator_minimum_active: 15,
  batch_op_groups: 1,
  epoch_retention_envelope_log_count: 64
}

function epochState(
  currentEpoch: number,
  nextEpochStart: string
): SysioContracts.SysioEpochEpochStateType {
  return {
    current_epoch_index: currentEpoch,
    current_epoch_start: "2026-08-11T20:47:00.000",
    next_epoch_start: nextEpochStart,
    current_batch_op_group: 0,
    batch_op_groups: [[]],
    last_consensus_hash: "0".repeat(64),
    is_paused: false
  }
}

function envelopeLog(
  epochIndex: number,
  emittedAt: string
): SysioContracts.SysioMsgchEnvelopeLogEntryType {
  const endpoint = {
    kind: SysioContracts.SysioMsgchChainkind.CHAIN_KIND_WIRE,
    id: { value: 0 }
  }
  return {
    id: epochIndex,
    endpoints: { start: endpoint, end: endpoint },
    epoch_index: epochIndex,
    checksum: "0".repeat(64),
    emitted_at: emittedAt
  }
}

function readinessContext(
  state: SysioContracts.SysioEpochEpochStateType,
  logs: SysioContracts.SysioMsgchEnvelopeLogEntryType[]
): ReadinessContext {
  const context = new ReadinessContext(
    {
      feature: ClusterReadinessFeature.swap,
      catalogUrl: "https://catalog.example",
      requestedWireChainId: "a".repeat(64),
      endpoints: [],
      catalogRecordCount: 0,
      catalogErrors: [],
      observationMs: 1,
      timeoutMs: 1,
      report: { path: "/tmp", basename: "readiness", formats: [] }
    },
    getLogger("cluster-readiness-steps-test")
  )
  jest
    .spyOn(context.wireSystem.epoch.tables.epochcfg, "query")
    .mockResolvedValue({ rows: [EpochConfig], more: false })
  jest
    .spyOn(context.wireSystem.epoch.tables.epochstate, "query")
    .mockResolvedValue({ rows: [state], more: false })
  jest
    .spyOn(context.wireSystem.msgch.tables.envlog, "query")
    .mockResolvedValue({ rows: logs, more: false })
  return context
}

function epochSchedulerStep() {
  return Steps.readiness.cluster.planEpochScheduler(
    Report.Actor.Sysio,
    "epoch-scheduler",
    "Verify active epoch scheduling",
    {}
  )
}

describe("ClusterReadinessSteps", () => {
  afterEach(() => jest.restoreAllMocks())

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

  it("classifies a scheduler inside the extension allowance as on time", () => {
    const assessment = assessEpochScheduler(
      50,
      "2026-08-11T20:00:00.000",
      60,
      [],
      Date.parse("2026-08-11T20:00:20.000Z")
    )

    expect(assessment).toMatchObject({
      state: ClusterEpochSchedulerState["on-time"],
      overdueMs: 20_000,
      maximumExtensionMs: 30_000,
      progressing: false
    })
  })

  it("distinguishes a recently advancing scheduler from a hard stall", () => {
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
      state: ClusterEpochSchedulerState["advancing-late"],
      overdueMs: 150_000,
      progressing: true,
      latestProgressEpoch: 55,
      previousProgressEpoch: 54,
      latestProgressAt: "2026-08-11T20:50:15.500",
      latestProgressAgeMs: 14_500
    })
  })

  it("reports an overdue scheduler as stalled or unproven without recent progression", () => {
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

    expect(assessment).toMatchObject({
      state: ClusterEpochSchedulerState["stalled-or-unproven"],
      progressing: false,
      latestProgressEpoch: 54,
      previousProgressEpoch: 53
    })
  })

  it("does not infer progression from repeated rows for one epoch", () => {
    const assessment = assessEpochScheduler(
      55,
      "2026-08-11T20:48:00.000",
      60,
      [
        { epochIndex: 55, emittedAt: "2026-08-11T20:50:15.500" },
        { epochIndex: 55, emittedAt: "2026-08-11T20:49:15.500" }
      ],
      Date.parse("2026-08-11T20:50:30.000Z")
    )

    expect(assessment.state).toBe(
      ClusterEpochSchedulerState["stalled-or-unproven"]
    )
    expect(assessment.progressing).toBe(false)
    expect(assessment.previousProgressEpoch).toBeUndefined()
  })

  it("does not call an invalid epoch configuration on time", () => {
    const assessment = assessEpochScheduler(
      55,
      "2026-08-11T20:50:00.000",
      0,
      [],
      Date.parse("2026-08-11T20:50:10.000Z")
    )

    expect(assessment.state).toBe(
      ClusterEpochSchedulerState["stalled-or-unproven"]
    )
  })

  it("records an on-time epoch scheduler as healthy", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-11T20:50:20.000Z"))
    const context = readinessContext(
        epochState(55, "2026-08-11T20:50:00.000"),
        []
      ),
      step = epochSchedulerStep()

    await step.runner(context, step.input, new AbortController().signal)

    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.pass,
        evidence: expect.objectContaining({
          classification: ClusterEpochSchedulerState["on-time"]
        })
      })
    ])
  })

  it("blocks but reports recent progression when an epoch scheduler is late", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-08-11T20:50:30.000Z"))
    const context = readinessContext(
        epochState(55, "2026-08-11T20:48:00.000"),
        [
          envelopeLog(55, "2026-08-11T20:50:15.500"),
          envelopeLog(54, "2026-08-11T20:49:15.500")
        ]
      ),
      step = epochSchedulerStep()

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("Recent scheduler progression reached epoch 55")
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        reason: ClusterReadinessReasonCode["protocol-degraded"],
        evidence: expect.objectContaining({
          classification: ClusterEpochSchedulerState["advancing-late"],
          progressing: true,
          latestProgressEpoch: 55,
          previousProgressEpoch: 54
        })
      })
    ])
  })
})
