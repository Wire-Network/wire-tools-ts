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

    it.each([
      ["a +00:00 offset", "2026-11-20T12:34:56+00:00"],
      ["the normalized form ClusterConfigProvider.resolve persists", "2026-11-20T12:34:56"]
    ])("pushes a start with %s as the UTC second it falls in", async (_form, startTime) => {
      const { ctx, invoke } = epochContext()
      await Steps.contracts.sysio.epoch.runSeteconomy(
        ctx,
        { kind: "EpochContractSteps.SeteconomyInput", epochDurationSec: 60, startTime },
        new AbortController().signal
      )
      expect(invoke).toHaveBeenCalledWith({
        epoch_duration_sec: 60,
        start_time: "2026-11-20T12:34:56"
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

describe("Steps.contracts.sysio.epoch pause / unpause", () => {
  afterEach(() => jest.restoreAllMocks())

  /** A real context whose epoch contract client is memoized for spying. */
  function epochContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.epoch)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    return { ctx, contract }
  }

  it("PauseAccount is sysio.chalg, the account the contract requires", () => {
    expect(Steps.contracts.sysio.epoch.PauseAccount).toBe("sysio.chalg")
  })

  it.each([
    ["planPause", "runPause", "pause"],
    ["planUnpause", "runUnpause", "unpause"]
  ] as const)("%s pushes an empty %s signed sysio.chalg@active", async (factory, runner, action) => {
    const { ctx, contract } = epochContext(),
      invoke = jest.spyOn(contract.actions[action], "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch[factory](Report.Actor.Sysio, action, action, {})
    expect(step.input).toBeNull()
    expect(step.runner).toBe(Steps.contracts.sysio.epoch[runner])
    await step.runner(ctx, null, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(
      {},
      { authorization: [{ actor: "sysio.chalg", permission: "active" }] }
    )
  })

  it.each(["runPause", "runUnpause"] as const)("an aborted %s pushes nothing", async runner => {
    const { ctx, contract } = epochContext(),
      pause = jest.spyOn(contract.actions.pause, "invoke").mockResolvedValue(undefined),
      unpause = jest.spyOn(contract.actions.unpause, "invoke").mockResolvedValue(undefined)
    await expect(
      Steps.contracts.sysio.epoch[runner](ctx, null, AbortSignal.abort())
    ).rejects.toThrow()
    expect(pause).not.toHaveBeenCalled()
    expect(unpause).not.toHaveBeenCalled()
  })
})

describe("Steps.contracts.sysio.epoch economic clock reads", () => {
  afterEach(() => jest.restoreAllMocks())

  /** A real context whose epoch contract client is memoized for spying. */
  function epochContract() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.epoch)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    return { ctx, contract }
  }

  it("readEconomyConfig unwraps the economycfg singleton, absent before seteconomy", async () => {
    const { ctx, contract } = epochContract(),
      row: SysioContracts.SysioEpochEconomicConfigType = {
        epoch_duration_sec: 120,
        start_time: "2026-11-23T00:00:00"
      },
      query = jest.spyOn(contract.tables.economycfg, "query")
    query.mockResolvedValueOnce({ rows: [row], more: false })
    await expect(Steps.contracts.sysio.epoch.readEconomyConfig(ctx)).resolves.toBe(row)
    query.mockResolvedValueOnce({ rows: [], more: false })
    await expect(Steps.contracts.sysio.epoch.readEconomyConfig(ctx)).resolves.toBeUndefined()
  })

  it("readEconomyState unwraps the economystate singleton, absent before the first tick", async () => {
    const { ctx, contract } = epochContract(),
      row: SysioContracts.SysioEpochEconomicStateType = {
        current_epoch_index: 4,
        current_epoch_start: "2026-11-23T00:06:00.000",
        next_epoch_start: "2026-11-23T00:08:00.000",
        caught_up: true
      },
      query = jest.spyOn(contract.tables.economystate, "query")
    query.mockResolvedValueOnce({ rows: [row], more: false })
    await expect(Steps.contracts.sysio.epoch.readEconomyState(ctx)).resolves.toBe(row)
    query.mockResolvedValueOnce({ rows: [], more: false })
    await expect(Steps.contracts.sysio.epoch.readEconomyState(ctx)).resolves.toBeUndefined()
  })

  it("readBlockLog returns the open episode, bounded by BlockLogRowLimit", async () => {
    const { ctx, contract } = epochContract(),
      row = { epoch_index: 7 } as SysioContracts.SysioEpochBlocklogEntryType,
      query = jest
        .spyOn(contract.tables.blocklog, "query")
        .mockResolvedValue({ rows: [row], more: false })
    await expect(Steps.contracts.sysio.epoch.readBlockLog(ctx)).resolves.toEqual([row])
    expect(query).toHaveBeenCalledWith({ limit: Steps.contracts.sysio.epoch.BlockLogRowLimit })
  })

  it("readBlockLog refuses a truncated read", async () => {
    const { ctx, contract } = epochContract()
    jest.spyOn(contract.tables.blocklog, "query").mockResolvedValue({ rows: [], more: true })
    await expect(Steps.contracts.sysio.epoch.readBlockLog(ctx)).rejects.toThrow(/truncated/)
  })
})
