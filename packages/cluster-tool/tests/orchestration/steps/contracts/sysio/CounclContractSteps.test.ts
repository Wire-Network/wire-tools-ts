import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

describe("Steps.contracts.sysio.councl", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.councl` client. */
  function counclContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.councl),
      getSysioContract = jest
        .spyOn(ctx.wire, "getSysioContract")
        .mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("syncnodes carries the councl::syncnodes data and binds runSyncnodes", () => {
    const data: SysioContracts.SysioCounclSyncnodesAction = { caller: "gova" },
      step = Steps.contracts.sysio.councl.planSyncnodes(
        Report.Actor.User,
        "syncnodes",
        "sync sysio.nodes@active",
        {},
        data
      )
    expect(step.actor).toBe(Report.Actor.User)
    expect(step.input).toEqual({ kind: "CounclContractSteps.SyncnodesInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.councl.runSyncnodes)
  })

  it("runSyncnodes pushes councl::syncnodes signed by the caller, not the contract", async () => {
    const { ctx, contract, getSysioContract } = counclContext(),
      invoke = jest
        .spyOn(contract.actions.syncnodes, "invoke")
        .mockResolvedValue(undefined),
      data: SysioContracts.SysioCounclSyncnodesAction = { caller: "govd" }
    await Steps.contracts.sysio.councl.runSyncnodes(
      ctx,
      { kind: "CounclContractSteps.SyncnodesInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.councl)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "govd", permission: "active" }]
    })
  })

  it("runSyncnodes pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = counclContext(),
      invoke = jest
        .spyOn(contract.actions.syncnodes, "invoke")
        .mockResolvedValue(undefined)
    await expect(
      Steps.contracts.sysio.councl.runSyncnodes(
        ctx,
        { kind: "CounclContractSteps.SyncnodesInput", data: { caller: "gova" } },
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("propagates the contract's refusal while no tier-1 owner is registered", async () => {
    const { ctx, contract } = counclContext()
    jest
      .spyOn(contract.actions.syncnodes, "invoke")
      .mockRejectedValue(new Error("no tier-1 node owner is registered"))
    await expect(
      Steps.contracts.sysio.councl.runSyncnodes(
        ctx,
        { kind: "CounclContractSteps.SyncnodesInput", data: { caller: "gova" } },
        signal
      )
    ).rejects.toThrow(/no tier-1 node owner/)
  })
})
