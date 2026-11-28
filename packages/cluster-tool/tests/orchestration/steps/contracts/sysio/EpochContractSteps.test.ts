import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { Constants } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** The packed `uint64` code an `epochstate` / `epochcfg` row carries for a chain. */
function packedCode(chain: Constants.OutpostChainCodename): number {
  return SlugName.from(chain)
}

/** A real context whose `sysio.epoch` client is memoized, with its per-chain tables stubbed. */
function contextWithChainRows(
  epochStates: SysioContracts.SysioEpochEpochStateType[],
  epochConfigs: SysioContracts.SysioEpochEpochConfigType[] = []
) {
  const ctx = fixtureContext(),
    contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.epoch)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  const stateQuery = jest
      .spyOn(contract.tables.epochstate, "query")
      .mockResolvedValue({ rows: epochStates, more: false }),
    configQuery = jest
      .spyOn(contract.tables.epochcfg, "query")
      .mockResolvedValue({ rows: epochConfigs, more: false })
  return { ctx, contract, stateQuery, configQuery }
}

/** A zero `time_point` as the chain renders it: `traffic_since` / `due_at` with no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/** One chain's whole `epochstate` row: its index, window and rotation cursor; idle. */
function epochStateRow(
  chain: Constants.OutpostChainCodename,
  currentEpochIndex: number,
  currentBatchOpGroup: number,
  batchOperatorGroups: string[][],
  isPaused = false
): SysioContracts.SysioEpochEpochStateType {
  return {
    chain_code: packedCode(chain),
    current_epoch_index: currentEpochIndex,
    current_epoch_start: "2026-11-24T00:00:00.000",
    traffic_since: NoTraffic,
    due_at: NoTraffic,
    current_batch_op_group: currentBatchOpGroup,
    batch_op_groups: batchOperatorGroups,
    is_paused: isPaused,
    previous_group: []
  }
}

/** One chain's whole `epochcfg` row. */
function epochConfigRow(
  chain: Constants.OutpostChainCodename,
  epochDurationSec: number
): SysioContracts.SysioEpochEpochConfigType {
  return {
    chain_code: packedCode(chain),
    epoch_duration_sec: epochDurationSec,
    traffic_wait_sec: Math.floor(epochDurationSec / 2),
    late_window_sec: Math.floor(epochDurationSec / 2),
    operators_per_epoch: 3,
    batch_operator_minimum_active: 9,
    batch_op_groups: 3,
    epoch_retention_envelope_log_count: 10
  }
}

const { ETHEREUM_CHAIN_CODENAME: Ethereum, SOLANA_CHAIN_CODENAME: Solana } = Constants

describe("Steps.contracts.sysio.epoch", () => {
  afterEach(() => jest.restoreAllMocks())

  it("setconfig carries the epoch::setconfig data, chain included", () => {
    const data: SysioContracts.SysioEpochSetconfigAction = {
      chain_code: Ethereum,
      epoch_duration_sec: 60,
      traffic_wait_sec: Steps.contracts.sysio.epoch.DefaultShareOfMinimumSec,
      late_window_sec: Steps.contracts.sysio.epoch.DefaultShareOfMinimumSec,
      operators_per_epoch: 3,
      batch_operator_minimum_active: 9,
      batch_op_groups: 3,
      epoch_retention_envelope_log_count: 10
    }
    const step = Steps.contracts.sysio.epoch.planSetconfig(
      Report.Actor.Sysio,
      "configure-epoch-ethereum",
      "set the ETHEREUM consensus epoch config",
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

  it("planSchbatchgps carries its chain and runSchbatchgps pushes it", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.schbatchgps, "invoke").mockResolvedValue(undefined),
      data = { chain_code: Solana },
      step = Steps.contracts.sysio.epoch.planSchbatchgps(Report.Actor.Sysio, "schbatchgps", "schbatchgps", {}, data)
    expect(step.input).toEqual({ kind: "EpochContractSteps.SchbatchgpsInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runSchbatchgps)
    await Steps.contracts.sysio.epoch.runSchbatchgps(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data)
  })

  it("planAdvance carries its chain and runAdvance signs it as sysio.epoch", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.advance, "invoke").mockResolvedValue(undefined),
      data = { chain_code: Solana },
      step = Steps.contracts.sysio.epoch.planAdvance(Report.Actor.Sysio, "advance", "advance", {}, data)
    expect(Steps.contracts.sysio.epoch.AdvanceAccount).toBe("sysio.epoch")
    expect(step.input).toEqual({ kind: "EpochContractSteps.AdvanceInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runAdvance)
    await Steps.contracts.sysio.epoch.runAdvance(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.epoch", permission: "active" }]
    })
  })

  it("planResendroster carries its chain and runResendroster signs it as sysio.epoch", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.resendroster, "invoke").mockResolvedValue(undefined),
      data = { code: Ethereum },
      step = Steps.contracts.sysio.epoch.planResendroster(
        Report.Actor.Sysio,
        "resendroster",
        "governance traffic",
        {},
        data
      )
    expect(Steps.contracts.sysio.epoch.ResendrosterAccount).toBe("sysio.epoch")
    expect(step.input).toEqual({ kind: "EpochContractSteps.ResendrosterInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runResendroster)
    await Steps.contracts.sysio.epoch.runResendroster(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.epoch", permission: "active" }]
    })
  })

  it("an aborted resendroster step pushes nothing", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.resendroster, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planResendroster(Report.Actor.Sysio, "resendroster", "resendroster", {}, {
        code: Solana
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("planNotetraffic carries its chain and since, and runNotetraffic signs it as sysio.msgch", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.notetraffic, "invoke").mockResolvedValue(undefined),
      data = { chain_code: Ethereum, since: Steps.contracts.sysio.epoch.TrafficSinceNow },
      step = Steps.contracts.sysio.epoch.planNotetraffic(Report.Actor.Sysio, "notetraffic", "traffic", {}, data)
    expect(Steps.contracts.sysio.epoch.NotetrafficAccount).toBe("sysio.msgch")
    expect(step.input).toEqual({ kind: "EpochContractSteps.NotetrafficInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runNotetraffic)
    await Steps.contracts.sysio.epoch.runNotetraffic(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.msgch", permission: "active" }]
    })
  })

  it("TrafficSinceNow is the zero time_point the contract reads as now", () => {
    expect(Steps.contracts.sysio.epoch.TrafficSinceNow).toBe(NoTraffic)
    expect(Date.parse(`${Steps.contracts.sysio.epoch.TrafficSinceNow}Z`)).toBe(
      Steps.contracts.sysio.epoch.NoTrafficMs
    )
  })

  it("an aborted notetraffic step pushes nothing", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.notetraffic, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planNotetraffic(Report.Actor.Sysio, "notetraffic", "traffic", {}, {
        chain_code: Solana,
        since: Steps.contracts.sysio.epoch.TrafficSinceNow
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("an aborted schbatchgps step pushes nothing", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.schbatchgps, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planSchbatchgps(Report.Actor.Sysio, "schbatchgps", "schbatchgps", {}, {
        chain_code: Solana
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("an aborted advance step pushes nothing", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      invoke = jest.spyOn(contract.actions.advance, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planAdvance(Report.Actor.Sysio, "advance", "advance", {}, {
        chain_code: Solana
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("Steps.contracts.sysio.epoch per-chain epochstate / epochcfg reads", () => {
  afterEach(() => jest.restoreAllMocks())

  const ethereumGroups = [["opa", "opb"], ["opc", "opd"], ["ope", "opf"]],
    solanaGroups = [["opf", "ope"], ["opd", "opc"], ["opb", "opa"]],
    rows = [
      epochStateRow(Ethereum, 7, 2, ethereumGroups),
      epochStateRow(Solana, 3, 0, solanaGroups, true)
    ]

  it("isChainRow matches a row's packed code, numeric or quoted", () => {
    expect(Steps.contracts.sysio.epoch.isChainRow(packedCode(Solana), Solana)).toBe(true)
    expect(Steps.contracts.sysio.epoch.isChainRow(String(packedCode(Solana)), Solana)).toBe(true)
    expect(Steps.contracts.sysio.epoch.isChainRow(packedCode(Solana), Ethereum)).toBe(false)
  })

  it("isChainRow refuses a slug spelling rather than misreading it as a code", () => {
    expect(() => Steps.contracts.sysio.epoch.isChainRow(Solana, Solana)).toThrow(/unsigned decimal/)
  })

  it("findChainRow picks the chain's own row, whatever the row order, and nothing for a missing chain", () => {
    expect(Steps.contracts.sysio.epoch.findChainRow(rows, Solana)).toBe(rows[1])
    expect(Steps.contracts.sysio.epoch.findChainRow([...rows].reverse(), Ethereum)).toBe(rows[0])
    expect(Steps.contracts.sysio.epoch.findChainRow([rows[0]], Solana)).toBeUndefined()
  })

  it("readEpochStates keys every chain's row from one bounded read", async () => {
    const { ctx, stateQuery } = contextWithChainRows([...rows].reverse())
    await expect(Steps.contracts.sysio.epoch.readEpochStates(ctx)).resolves.toEqual({
      [Ethereum]: rows[0],
      [Solana]: rows[1]
    })
    expect(stateQuery).toHaveBeenCalledWith({ limit: Steps.contracts.sysio.epoch.ChainRowLimit })
  })

  it("readEpochStates leaves a chain without a row absent", async () => {
    const { ctx } = contextWithChainRows([rows[0]])
    await expect(Steps.contracts.sysio.epoch.readEpochStates(ctx)).resolves.toEqual({
      [Ethereum]: rows[0],
      [Solana]: undefined
    })
  })

  it("readEpochStates refuses a truncated read", async () => {
    const { ctx, stateQuery } = contextWithChainRows(rows)
    stateQuery.mockResolvedValue({ rows, more: true })
    await expect(Steps.contracts.sysio.epoch.readEpochStates(ctx)).rejects.toThrow(/truncated/)
  })

  it("readRostersSent keys each chain's last-queued roster hash from one bounded read, absent once erased", async () => {
    const { ctx, contract } = contextWithChainRows([]),
      sent = [{ chain_code: packedCode(Solana), roster_hash: "ab".repeat(32) }],
      query = jest.spyOn(contract.tables.rostersent, "query").mockResolvedValue({ rows: sent, more: false })
    await expect(Steps.contracts.sysio.epoch.readRostersSent(ctx)).resolves.toEqual({
      [Ethereum]: undefined,
      [Solana]: sent[0]
    })
    expect(query).toHaveBeenCalledWith({ limit: Steps.contracts.sysio.epoch.ChainRowLimit })
  })

  it("readRostersSent refuses a truncated read", async () => {
    const { ctx, contract } = contextWithChainRows([])
    jest.spyOn(contract.tables.rostersent, "query").mockResolvedValue({ rows: [], more: true })
    await expect(Steps.contracts.sysio.epoch.readRostersSent(ctx)).rejects.toThrow(/rostersent.*truncated/)
  })

  it("readEpochState picks the chain's own row", async () => {
    const { ctx } = contextWithChainRows(rows)
    await expect(Steps.contracts.sysio.epoch.readEpochState(ctx, Solana)).resolves.toBe(rows[1])
    await expect(Steps.contracts.sysio.epoch.readEpochState(ctx, Ethereum)).resolves.toBe(rows[0])
  })

  it("readCurrentEpochIndex / readCurrentEpochIndices read each chain's own index, 0 before its row", async () => {
    const { ctx } = contextWithChainRows([rows[0]])
    await expect(Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, Ethereum)).resolves.toBe(7)
    await expect(Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, Solana)).resolves.toBe(0)
    await expect(Steps.contracts.sysio.epoch.readCurrentEpochIndices(ctx)).resolves.toEqual({
      [Ethereum]: 7,
      [Solana]: 0
    })
  })

  it("everyChainAdvancedPast holds only once EVERY chain is past its index", () => {
    const before = { [Ethereum]: 4, [Solana]: 2 }
    expect(Steps.contracts.sysio.epoch.everyChainAdvancedPast({ [Ethereum]: 5, [Solana]: 3 }, before)).toBe(true)
    expect(Steps.contracts.sysio.epoch.everyChainAdvancedPast({ [Ethereum]: 9, [Solana]: 2 }, before)).toBe(false)
    expect(Steps.contracts.sysio.epoch.everyChainAdvancedPast({ [Ethereum]: 4, [Solana]: 9 }, before)).toBe(false)
    expect(Steps.contracts.sysio.epoch.everyChainAdvancedPast(before, before)).toBe(false)
  })

  it("isSeated finds an account in any group of the chain's window, current or ahead", () => {
    expect(Steps.contracts.sysio.epoch.isSeated(rows[0], "opa")).toBe(true)
    expect(Steps.contracts.sysio.epoch.isSeated(rows[0], "opf")).toBe(true)
    expect(Steps.contracts.sysio.epoch.isSeated(rows[0], "opz")).toBe(false)
  })

  it("isSeated seats nobody on a chain without a schedule", () => {
    expect(Steps.contracts.sysio.epoch.isSeated(undefined, "opa")).toBe(false)
    expect(Steps.contracts.sysio.epoch.isSeated(epochStateRow(Ethereum, 0, 0, []), "opa")).toBe(false)
  })

  it("batchOperatorGroups returns the chain's WHOLE sliding window", async () => {
    const { ctx } = contextWithChainRows(rows)
    await expect(Steps.contracts.sysio.epoch.batchOperatorGroups(ctx, Solana)).resolves.toEqual(
      solanaGroups
    )
  })

  it("activeBatchOperatorGroup indexes the chain's window by its rotation cursor, never [0]", async () => {
    // The window rotates: at cursor 2 the ACTIVE group is the third one. A
    // hardcoded `[0]` would return the expired group and silently pass.
    const { ctx } = contextWithChainRows(rows)
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx, Ethereum)
    ).resolves.toEqual(ethereumGroups[2])
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx, Solana)
    ).resolves.toEqual(solanaGroups[0])
  })

  it("readEpochConfigs / readEpochConfig key each chain's epochcfg row, absent before its setconfig", async () => {
    const ethereum = epochConfigRow(Ethereum, 60),
      { ctx, configQuery } = contextWithChainRows([], [ethereum])
    await expect(Steps.contracts.sysio.epoch.readEpochConfigs(ctx)).resolves.toEqual({
      [Ethereum]: ethereum,
      [Solana]: undefined
    })
    await expect(Steps.contracts.sysio.epoch.readEpochConfig(ctx, Ethereum)).resolves.toBe(ethereum)
    await expect(Steps.contracts.sysio.epoch.readEpochConfig(ctx, Solana)).resolves.toBeUndefined()
    configQuery.mockResolvedValue({ rows: [ethereum], more: true })
    await expect(Steps.contracts.sysio.epoch.readEpochConfigs(ctx)).rejects.toThrow(/truncated/)
  })

  it("readEpochDurationSec reads the chain's epochcfg duration", async () => {
    const { ctx } = contextWithChainRows([], [epochConfigRow(Ethereum, 60), epochConfigRow(Solana, 150)])
    await expect(Steps.contracts.sysio.epoch.readEpochDurationSec(ctx, Solana)).resolves.toBe(150)
    await expect(Steps.contracts.sysio.epoch.readEpochDurationSec(ctx, Ethereum)).resolves.toBe(60)
  })

  it("readEpochDurationSec refuses a chain whose setconfig has not run", async () => {
    const { ctx } = contextWithChainRows([], [epochConfigRow(Ethereum, 60)])
    await expect(Steps.contracts.sysio.epoch.readEpochDurationSec(ctx, Solana)).rejects.toThrow(
      new RegExp(`epochcfg has no ${Solana} row`)
    )
  })

  it("tolerates a chain that has no epoch state yet", async () => {
    const { ctx } = contextWithChainRows([])
    await expect(Steps.contracts.sysio.epoch.batchOperatorGroups(ctx, Ethereum)).resolves.toEqual([])
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx, Ethereum)
    ).resolves.toBeUndefined()
  })
})

describe("Steps.contracts.sysio.epoch traffic predicates", () => {
  const epoch = Steps.contracts.sysio.epoch,
    StartMs = Date.parse("2026-11-24T00:00:00.000Z"),
    DueAt = "2026-11-24T00:01:30.000",
    DueAtMs = Date.parse(`${DueAt}Z`)

  /** A started chain's row with traffic since `since`, due at `dueAt`. */
  function withTraffic(
    since: string,
    dueAt: string,
    index = 4
  ): SysioContracts.SysioEpochEpochStateType {
    return { ...epochStateRow(Ethereum, index, 0, []), traffic_since: since, due_at: dueAt }
  }

  it("reads a zero time_point as no traffic and a set one as its instant", () => {
    const idle = epochStateRow(Ethereum, 4, 0, []),
      busy = withTraffic("2026-11-24T00:00:30.000", DueAt)
    expect(epoch.dueAtMs(idle)).toBe(epoch.NoTrafficMs)
    expect(epoch.trafficSinceMs(idle)).toBe(epoch.NoTrafficMs)
    expect(epoch.dueAtMs(busy)).toBe(DueAtMs)
    expect(epoch.trafficSinceMs(busy)).toBe(StartMs + 30_000)
  })

  it("isIdle holds for a started chain with no traffic", () => {
    expect(epoch.isIdle(epochStateRow(Ethereum, 1, 0, []))).toBe(true)
    expect(epoch.isIdle(epochStateRow(Solana, 9, 0, [], true))).toBe(true)
  })

  it("isIdle is false with traffic, before the genesis advance, or without a row", () => {
    expect(epoch.isIdle(withTraffic("2026-11-24T00:00:30.000", DueAt))).toBe(false)
    expect(epoch.isIdle(epochStateRow(Ethereum, 0, 0, []))).toBe(false)
    expect(epoch.isIdle(undefined)).toBe(false)
  })

  it("isIdle fails closed on a due_at that is absent or does not parse", () => {
    const { due_at: _dueAt, ...withoutDueAt } = epochStateRow(Ethereum, 3, 0, [])
    expect(epoch.isIdle(withoutDueAt as SysioContracts.SysioEpochEpochStateType)).toBe(false)
    expect(epoch.isIdle({ ...epochStateRow(Ethereum, 3, 0, []), due_at: "not a time" })).toBe(false)
  })

  it("msUntilDue counts down to due_at and goes non-positive once due", () => {
    const busy = withTraffic("2026-11-24T00:00:30.000", DueAt)
    expect(epoch.msUntilDue(busy, StartMs)).toBe(90_000)
    expect(epoch.msUntilDue(busy, DueAtMs)).toBe(0)
    expect(epoch.msUntilDue(busy, DueAtMs + 5_000)).toBe(-5_000)
  })

  it("msUntilDue is infinite with no traffic: an idle chain is never due", () => {
    expect(epoch.msUntilDue(epochStateRow(Ethereum, 4, 0, []), StartMs)).toBe(
      Number.POSITIVE_INFINITY
    )
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

  it("planPause pushes one chain's pause signed sysio.chalg@active", async () => {
    const { ctx, contract } = epochContext(),
      invoke = jest.spyOn(contract.actions.pause, "invoke").mockResolvedValue(undefined),
      data = { chain_code: Ethereum },
      step = Steps.contracts.sysio.epoch.planPause(Report.Actor.Sysio, "pause", "pause", {}, data)
    expect(step.input).toEqual({ kind: "EpochContractSteps.PauseInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runPause)
    await step.runner(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.chalg", permission: "active" }]
    })
  })

  it("planUnpause pushes one chain's unpause signed sysio.chalg@active", async () => {
    const { ctx, contract } = epochContext(),
      invoke = jest.spyOn(contract.actions.unpause, "invoke").mockResolvedValue(undefined),
      data = { chain_code: Ethereum },
      step = Steps.contracts.sysio.epoch.planUnpause(Report.Actor.Sysio, "unpause", "unpause", {}, data)
    expect(step.input).toEqual({ kind: "EpochContractSteps.UnpauseInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.epoch.runUnpause)
    await step.runner(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.chalg", permission: "active" }]
    })
  })

  it("an aborted pause step pushes nothing", async () => {
    const { ctx, contract } = epochContext(),
      invoke = jest.spyOn(contract.actions.pause, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planPause(Report.Actor.Sysio, "pause", "pause", {}, {
        chain_code: Ethereum
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("an aborted unpause step pushes nothing", async () => {
    const { ctx, contract } = epochContext(),
      invoke = jest.spyOn(contract.actions.unpause, "invoke").mockResolvedValue(undefined),
      step = Steps.contracts.sysio.epoch.planUnpause(Report.Actor.Sysio, "unpause", "unpause", {}, {
        chain_code: Ethereum
      })
    await expect(step.runner(ctx, step.input, AbortSignal.abort())).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
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
      row: SysioContracts.SysioEpochBlocklogEntryType = {
        epoch_index: 7,
        last_epoch_index: 7,
        reason: SysioContracts.SysioEpochEmissionsblockreason.EMISSIONS_BLOCK_REASON_BALANCE_INSUFFICIENT,
        attempted_emission: 1,
        treasury_remaining: 1,
        sysio_balance: 0,
        first_blocked_at: 0,
        last_blocked_at: 0,
        blocked_epochs: 1
      },
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
