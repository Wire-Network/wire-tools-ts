import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

/** The system account, which signs the governance actions. */
const SystemAccount = "sysio"

/** The `authorization` option a runner passes when `account@active` signs. */
function signedBy(account: string) {
  return { authorization: [{ actor: account, permission: "active" }] }
}

describe("Steps.contracts.sysio.andon", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.andon` client. */
  function andonContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.andon),
      getSysioContract = jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("setpanic carries the andon::setpanic data and binds runSetpanic", () => {
    const data: SysioContracts.SysioAndonSetpanicAction = { account: "andon.panic" }
    const step = Steps.contracts.sysio.andon.planSetpanic(
      Report.Actor.Sysio,
      "andon-setpanic",
      "push andon::setpanic",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "AndonContractSteps.SetpanicInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.andon.runSetpanic)
  })

  it("runSetpanic pushes andon::setpanic as the system account", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest.spyOn(contract.actions.setpanic, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonSetpanicAction = { account: "andon.panic" }
    await Steps.contracts.sysio.andon.runSetpanic(
      ctx,
      { kind: "AndonContractSteps.SetpanicInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("addpuller carries the andon::addpuller data and binds runAddpuller", () => {
    const data: SysioContracts.SysioAndonAddpullerAction = { contract: "sysio.synd" }
    const step = Steps.contracts.sysio.andon.planAddpuller(
      Report.Actor.Sysio,
      "andon-addpuller",
      "push andon::addpuller",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "AndonContractSteps.AddpullerInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.andon.runAddpuller)
  })

  it("runAddpuller pushes andon::addpuller as the system account", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest.spyOn(contract.actions.addpuller, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonAddpullerAction = { contract: "sysio.synd" }
    await Steps.contracts.sysio.andon.runAddpuller(
      ctx,
      { kind: "AndonContractSteps.AddpullerInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("pull carries the andon::pull data and binds runPull", () => {
    const data: SysioContracts.SysioAndonPullAction = { actor: "andon.panic", reason: "custody drill" }
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

  it("runPull pushes andon::pull as the pulling actor", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest.spyOn(contract.actions.pull, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonPullAction = { actor: "andon.panic", reason: "custody drill" }
    await Steps.contracts.sysio.andon.runPull(
      ctx,
      { kind: "AndonContractSteps.PullInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(data.actor))
  })

  it("clear carries the andon::clear data and binds runClear", () => {
    const data: SysioContracts.SysioAndonClearAction = { actor: "andon.panic", note: "drill over" }
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

  it("runClear pushes andon::clear as the clearing actor", async () => {
    const { ctx, contract, getSysioContract } = andonContext(),
      invoke = jest.spyOn(contract.actions.clear, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioAndonClearAction = { actor: "andon.panic", note: "drill over" }
    await Steps.contracts.sysio.andon.runClear(
      ctx,
      { kind: "AndonContractSteps.ClearInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.andon)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(data.actor))
  })

  it("runSetpanic pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = andonContext(),
      invoke = jest.spyOn(contract.actions.setpanic, "invoke").mockResolvedValue(undefined),
      controller = new AbortController(),
      data: SysioContracts.SysioAndonSetpanicAction = { account: "andon.panic" }
    controller.abort()
    await expect(
      Steps.contracts.sysio.andon.runSetpanic(
        ctx,
        { kind: "AndonContractSteps.SetpanicInput", data },
        controller.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
