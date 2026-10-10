import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** The LIQ token every pool case below addresses. */
const LiqToken = "LIQETH"
/** The governance signature every kicker configuration action requires. */
const SysioActive = [{ actor: "sysio", permission: "active" }]

const setconfigData: SysioContracts.SysioKickerSetconfigAction = {
    cfg: { budget_remaining: 1_000_000_000_000_000, min_interval_sec: 60 }
  },
  addpoolData: SysioContracts.SysioKickerAddpoolAction = {
    sym: LiqToken,
    rate_bps: 200,
    min_gift: 1_000_000_000,
    max_gift_per_day: 0
  },
  setpoolData: SysioContracts.SysioKickerSetpoolAction = {
    sym: LiqToken,
    rate_bps: 200,
    min_gift: 1,
    max_gift_per_day: 0
  }

/** A context whose kicker client is the one the runner resolves, for spying on its actions. */
function kickerContext() {
  const ctx = fixtureContext(),
    contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.kicker)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  return { ctx, contract }
}

describe("Steps.contracts.sysio.kicker", () => {
  afterEach(() => jest.restoreAllMocks())

  it("signs governance actions as sysio@active, not the contract's own permission", () => {
    expect(Steps.contracts.sysio.kicker.GovernanceAuthorization).toEqual(SysioActive)
  })

  it("setconfig carries the kicker::setconfig data", () => {
    const step = Steps.contracts.sysio.kicker.planSetconfig(
      Report.Actor.Sysio,
      "configure-kicker",
      "set the kicker's budget",
      {},
      setconfigData
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "KickerContractSteps.SetconfigInput", data: setconfigData })
    expect(step.runner).toBe(Steps.contracts.sysio.kicker.runSetconfig)
  })

  it("addpool carries the kicker::addpool data", () => {
    const step = Steps.contracts.sysio.kicker.planAddpool(
      Report.Actor.Sysio,
      "add-kicker-pool-liqeth",
      "start LIQETH's accrual",
      {},
      addpoolData
    )
    expect(step.input).toEqual({ kind: "KickerContractSteps.AddpoolInput", data: addpoolData })
    expect(step.runner).toBe(Steps.contracts.sysio.kicker.runAddpool)
  })

  it("setpool carries the kicker::setpool data", () => {
    const step = Steps.contracts.sysio.kicker.planSetpool(
      Report.Actor.Sysio,
      "lower-min-gift",
      "lower LIQETH's minimum gift",
      {},
      setpoolData
    )
    expect(step.input).toEqual({ kind: "KickerContractSteps.SetpoolInput", data: setpoolData })
    expect(step.runner).toBe(Steps.contracts.sysio.kicker.runSetpool)
  })

  it("pushes setconfig, addpool and setpool under sysio@active", async () => {
    const { ctx, contract } = kickerContext(),
      setconfig = jest.spyOn(contract.actions.setconfig, "invoke").mockResolvedValue(undefined),
      addpool = jest.spyOn(contract.actions.addpool, "invoke").mockResolvedValue(undefined),
      setpool = jest.spyOn(contract.actions.setpool, "invoke").mockResolvedValue(undefined),
      signal = new AbortController().signal
    await Steps.contracts.sysio.kicker.runSetconfig(
      ctx,
      { kind: "KickerContractSteps.SetconfigInput", data: setconfigData },
      signal
    )
    await Steps.contracts.sysio.kicker.runAddpool(
      ctx,
      { kind: "KickerContractSteps.AddpoolInput", data: addpoolData },
      signal
    )
    await Steps.contracts.sysio.kicker.runSetpool(
      ctx,
      { kind: "KickerContractSteps.SetpoolInput", data: setpoolData },
      signal
    )
    expect(setconfig).toHaveBeenCalledWith(setconfigData, { authorization: SysioActive })
    expect(addpool).toHaveBeenCalledWith(addpoolData, { authorization: SysioActive })
    expect(setpool).toHaveBeenCalledWith(setpoolData, { authorization: SysioActive })
  })

  it("pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = kickerContext(),
      addpool = jest.spyOn(contract.actions.addpool, "invoke").mockResolvedValue(undefined),
      controller = new AbortController()
    controller.abort()
    await expect(
      Steps.contracts.sysio.kicker.runAddpool(
        ctx,
        { kind: "KickerContractSteps.AddpoolInput", data: addpoolData },
        controller.signal
      )
    ).rejects.toThrow()
    expect(addpool).not.toHaveBeenCalled()
  })
})
