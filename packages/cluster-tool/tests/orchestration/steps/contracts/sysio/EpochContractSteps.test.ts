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

/** One chain's whole `epochstate` row: its index, window and rotation cursor. */
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
    next_epoch_start: "2026-11-24T00:01:00.000",
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
        next_epoch_start: "2026-11-23T00:08:00.000"
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
