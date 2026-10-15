import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

describe("Steps.contracts.sysio.andon", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.andon` client. */
  function andonContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.andon),
      getSysioContract = jest
        .spyOn(ctx.wire, "getSysioContract")
        .mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("pull carries the andon::pull data and binds runPull", () => {
    const data: SysioContracts.SysioAndonPullAction = {
      reason: "custody drill"
    }
    const step = Steps.contracts.sysio.andon.planPull(
      Report.Actor.Sysio,
      "andon-pull",
      "push andon::pull",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "AndonContractSteps.PullInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.andon.runPull)
  })

  it("runPull pushes andon::pull with the linked pull permission", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest
        .spyOn(contract.actions.pull, "invoke")
        .mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonPullAction = { reason: "custody drill" }
    await Steps.contracts.sysio.andon.runPull(
      ctx,
      { kind: "AndonContractSteps.PullInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.andon", permission: "pull" }]
    })
  })

  it("clear carries the andon::clear data and binds runClear", () => {
    const data: SysioContracts.SysioAndonClearAction = { note: "drill over" }
    const step = Steps.contracts.sysio.andon.planClear(
      Report.Actor.Sysio,
      "andon-clear",
      "push andon::clear",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "AndonContractSteps.ClearInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.andon.runClear)
  })

  it("runClear pushes andon::clear with the linked clear permission", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest
        .spyOn(contract.actions.clear, "invoke")
        .mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonClearAction = { note: "drill over" }
    await Steps.contracts.sysio.andon.runClear(
      ctx,
      { kind: "AndonContractSteps.ClearInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, {
      authorization: [{ actor: "sysio.andon", permission: "clear" }]
    })
  })

  it("runPull pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = andonContext(),
      invoke = jest
        .spyOn(contract.actions.pull, "invoke")
        .mockResolvedValue(undefined),
      controller = new AbortController(),
      data: SysioContracts.SysioAndonPullAction = { reason: "custody drill" }
    controller.abort()
    await expect(
      Steps.contracts.sysio.andon.runPull(
        ctx,
        { kind: "AndonContractSteps.PullInput", data },
        controller.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("runClear cannot clear the cord once the step is aborted", async () => {
    const { ctx, contract } = andonContext()
    const invoke = jest
      .spyOn(contract.actions.clear, "invoke")
      .mockResolvedValue(undefined)
    const controller = new AbortController()
    controller.abort()
    await expect(
      Steps.contracts.sysio.andon.runClear(
        ctx,
        { kind: "AndonContractSteps.ClearInput", data: { note: "drill over" } },
        controller.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
