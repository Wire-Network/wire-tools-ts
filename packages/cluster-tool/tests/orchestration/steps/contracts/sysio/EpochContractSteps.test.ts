import {
  Steps,
  type ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** The depot's `epochstate` query result, typed from the client that returns it. */
type EpochStateQueryResult = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getEpochState"]>
>

/** The depot's `epochcfg` query result, typed from the client that returns it. */
type EpochConfigQueryResult = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getEpochConfig"]>
>

/** A `epochstate` singleton read stubbed onto a REAL context's memoized client. */
function contextWithEpochState(
  ...rows: SysioContracts.SysioEpochEpochStateType[]
): ClusterBuildContext {
  const ctx = fixtureContext()
  jest
    .spyOn(ctx.wire, "getEpochState")
    .mockResolvedValue({ rows } as EpochStateQueryResult)
  return ctx
}

/** The schedule window + its rotation cursor — the only fields these reads touch. */
function epochStateRow(
  currentBatchOpGroup: number,
  batchOperatorGroups: string[][]
): SysioContracts.SysioEpochEpochStateType {
  return {
    current_batch_op_group: currentBatchOpGroup,
    batch_op_groups: batchOperatorGroups
  } as SysioContracts.SysioEpochEpochStateType
}

describe("Steps.contracts.sysio.epoch", () => {
  it("setconfig carries the epoch::setconfig data", () => {
    const data: SysioContracts.SysioEpochSetconfigAction = {
      epoch_duration_sec: 60,
      operators_per_epoch: 3,
      batch_operator_minimum_active: 9,
      batch_op_groups: 3,
      epoch_retention_envelope_log_count: 10
    }
    const step = Steps.contracts.sysio.epoch.planSetconfig(
      Report.Actor.Sysio,
      "configure-epoch",
      "set the global epoch config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("EpochContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("seteconomy carries the economic clock's duration and start", () => {
    const step = Steps.contracts.sysio.epoch.planSeteconomy(
      Report.Actor.Sysio,
      "configure-economy",
      "set the economic clock",
      {},
      300,
      "2026-11-19T00:00:00"
    )
    expect(step.input).toEqual({
      kind: "EpochContractSteps.SeteconomyInput",
      epochDurationSec: 300,
      startTime: "2026-11-19T00:00:00"
    })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runSeteconomy)
  })

  describe("runSeteconomy", () => {
    afterEach(() => jest.restoreAllMocks())

    /** A real context whose epoch contract client is memoized for spying. */
    function epochContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.epoch)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      const invoke = jest.spyOn(contract.actions.seteconomy, "invoke").mockResolvedValue(undefined),
        head = jest.spyOn(ctx.wire, "chainHeadTimestamp").mockResolvedValue("2026-11-19T10:20:30")
      return { ctx, invoke, head }
    }

    it("anchors a null start at the chain head", async () => {
      const { ctx, invoke, head } = epochContext()
      await Steps.contracts.sysio.epoch.runSeteconomy(
        ctx,
        { kind: "EpochContractSteps.SeteconomyInput", epochDurationSec: 60, startTime: null },
        new AbortController().signal
      )
      expect(head).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith({
        epoch_duration_sec: 60,
        start_time: "2026-11-19T10:20:30"
      })
    })

    it("passes a configured past start as the second it falls in, without reading the head", async () => {
      const { ctx, invoke, head } = epochContext()
      await Steps.contracts.sysio.epoch.runSeteconomy(
        ctx,
        {
          kind: "EpochContractSteps.SeteconomyInput",
          epochDurationSec: 360,
          startTime: "2026-11-01T06:00:00.750Z"
        },
        new AbortController().signal
      )
      expect(head).not.toHaveBeenCalled()
      expect(invoke).toHaveBeenCalledWith({
        epoch_duration_sec: 360,
        start_time: "2026-11-01T06:00:00"
      })
    })

    it("refuses an unparseable start before pushing", async () => {
      const { ctx, invoke } = epochContext()
      await expect(
        Steps.contracts.sysio.epoch.runSeteconomy(
          ctx,
          { kind: "EpochContractSteps.SeteconomyInput", epochDurationSec: 60, startTime: "yesterday" },
          new AbortController().signal
        )
      ).rejects.toThrow(/unparseable timestamp/)
      expect(invoke).not.toHaveBeenCalled()
    })

    it("an aborted step pushes nothing", async () => {
      const { ctx, invoke } = epochContext()
      await expect(
        Steps.contracts.sysio.epoch.runSeteconomy(
          ctx,
          { kind: "EpochContractSteps.SeteconomyInput", epochDurationSec: 60, startTime: null },
          AbortSignal.abort()
        )
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  it.each(["planSchbatchgps", "planAdvance"] as const)(
    "%s builds an input-less step with a runner",
    action => {
      const factory = Steps.contracts.sysio.epoch[action]
      const step = factory(Report.Actor.Sysio, action, `crank ${action}`, {})
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})

describe("Steps.contracts.sysio.epoch epochstate reads", () => {
  const groups = [["opa", "opb"], ["opc", "opd"], ["ope", "opf"]]

  it("readEpochState unwraps the singleton row", async () => {
    const row = epochStateRow(0, groups)
    await expect(
      Steps.contracts.sysio.epoch.readEpochState(contextWithEpochState(row))
    ).resolves.toBe(row)
  })

  it("batchOperatorGroups returns the WHOLE sliding window", async () => {
    await expect(
      Steps.contracts.sysio.epoch.batchOperatorGroups(
        contextWithEpochState(epochStateRow(1, groups))
      )
    ).resolves.toEqual(groups)
  })

  it("activeBatchOperatorGroup indexes by the rotation cursor, never [0]", async () => {
    // The window rotates: at cursor 2 the ACTIVE group is the third one. A
    // hardcoded `[0]` would return the expired group and silently pass.
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(
        contextWithEpochState(epochStateRow(2, groups))
      )
    ).resolves.toEqual(groups[2])
  })

  it("readEpochConfig unwraps the epochcfg singleton row, absent when the table is empty", async () => {
    const row: SysioContracts.SysioEpochEpochConfigType = {
        epoch_duration_sec: 60,
        operators_per_epoch: 3,
        batch_operator_minimum_active: 9,
        batch_op_groups: 3,
        epoch_retention_envelope_log_count: 10
      },
      ctx = fixtureContext(),
      configQuery = jest.spyOn(ctx.wire, "getEpochConfig")
    configQuery.mockResolvedValueOnce({ rows: [row] } as EpochConfigQueryResult)
    await expect(Steps.contracts.sysio.epoch.readEpochConfig(ctx)).resolves.toBe(row)
    configQuery.mockResolvedValueOnce({ rows: [] } as EpochConfigQueryResult)
    await expect(Steps.contracts.sysio.epoch.readEpochConfig(ctx)).resolves.toBeUndefined()
  })

  it("tolerates an epoch state that has no row yet", async () => {
    const ctx = contextWithEpochState()
    await expect(
      Steps.contracts.sysio.epoch.batchOperatorGroups(ctx)
    ).resolves.toEqual([])
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx)
    ).resolves.toBeUndefined()
  })
})
