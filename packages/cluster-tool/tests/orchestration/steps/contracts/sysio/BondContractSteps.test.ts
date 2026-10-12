import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

/** The account whose signature carries a permissionless push in the cases below. */
const CpuPayer = "cpu.payer"
/** The system account, which signs the governance actions. */
const SystemAccount = "sysio"

/** The `authorization` option a runner passes when `account@active` signs. */
function signedBy(account: string) {
  return { authorization: [{ actor: account, permission: "active" }] }
}

describe("Steps.contracts.sysio.bond", () => {
  const signal = new AbortController().signal

  /** A fixture context whose `getSysioContract` hands back one shared `sysio.bond` client. */
  function bondContext() {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.bond),
      getSysioContract = jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    return { ctx, contract, getSysioContract }
  }

  afterEach(() => jest.restoreAllMocks())

  it("setconfig carries the bond::setconfig data and binds runSetconfig", () => {
    const data: SysioContracts.SysioBondSetconfigAction = { hold_bps: 1000 }
    const step = Steps.contracts.sysio.bond.planSetconfig(
      Report.Actor.Underwriter,
      "bond-setconfig",
      "push bond::setconfig",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.SetconfigInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runSetconfig)
  })

  it("runSetconfig pushes bond::setconfig as the system account", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.setconfig, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondSetconfigAction = { hold_bps: 1000 }
    await Steps.contracts.sysio.bond.runSetconfig(
      ctx,
      { kind: "BondContractSteps.SetconfigInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("accept carries the bond::accept data and binds runAccept", () => {
    const data: SysioContracts.SysioBondAcceptAction = { underwriter: "bonder.a", request_id: 7, amount: "1000000000" }
    const step = Steps.contracts.sysio.bond.planAccept(
      Report.Actor.Underwriter,
      "bond-accept",
      "push bond::accept",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.AcceptInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runAccept)
  })

  it("runAccept pushes bond::accept as the underwriter", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.accept, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondAcceptAction = { underwriter: "bonder.a", request_id: 7, amount: "1000000000" }
    await Steps.contracts.sysio.bond.runAccept(
      ctx,
      { kind: "BondContractSteps.AcceptInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(data.underwriter))
  })

  it("approve carries the bond::approve data and binds runApprove", () => {
    const data: SysioContracts.SysioBondApproveAction = { request_id: 7 }
    const step = Steps.contracts.sysio.bond.planApprove(
      Report.Actor.Underwriter,
      "bond-approve",
      "push bond::approve",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.ApproveInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runApprove)
  })

  it("runApprove pushes bond::approve as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.approve, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondApproveAction = { request_id: 7 }
    await Steps.contracts.sysio.bond.runApprove(
      ctx,
      { kind: "BondContractSteps.ApproveInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("rslvvalid carries the bond::rslvvalid data and binds runRslvvalid", () => {
    const data: SysioContracts.SysioBondRslvvalidAction = { request_id: 7 }
    const step = Steps.contracts.sysio.bond.planRslvvalid(
      Report.Actor.Underwriter,
      "bond-rslvvalid",
      "push bond::rslvvalid",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.RslvvalidInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runRslvvalid)
  })

  it("runRslvvalid pushes bond::rslvvalid as the system account", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.rslvvalid, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondRslvvalidAction = { request_id: 7 }
    await Steps.contracts.sysio.bond.runRslvvalid(
      ctx,
      { kind: "BondContractSteps.RslvvalidInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("rslvinvalid carries the bond::rslvinvalid data and binds runRslvinvalid", () => {
    const data: SysioContracts.SysioBondRslvinvalidAction = { request_id: 7 }
    const step = Steps.contracts.sysio.bond.planRslvinvalid(
      Report.Actor.Underwriter,
      "bond-rslvinvalid",
      "push bond::rslvinvalid",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.RslvinvalidInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runRslvinvalid)
  })

  it("runRslvinvalid pushes bond::rslvinvalid as the system account", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.rslvinvalid, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondRslvinvalidAction = { request_id: 7 }
    await Steps.contracts.sysio.bond.runRslvinvalid(
      ctx,
      { kind: "BondContractSteps.RslvinvalidInput", data },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(SystemAccount))
  })

  it("claim carries the bond::claim data and binds runClaim", () => {
    const data: SysioContracts.SysioBondClaimAction = { request_id: 7, account: "bonder.a" }
    const step = Steps.contracts.sysio.bond.planClaim(
      Report.Actor.Underwriter,
      "bond-claim",
      "push bond::claim",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.ClaimInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runClaim)
  })

  it("runClaim pushes bond::claim as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.claim, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondClaimAction = { request_id: 7, account: "bonder.a" }
    await Steps.contracts.sysio.bond.runClaim(
      ctx,
      { kind: "BondContractSteps.ClaimInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("prune carries the bond::prune data and binds runPrune", () => {
    const data: SysioContracts.SysioBondPruneAction = { from_id: 0, limit: 16 }
    const step = Steps.contracts.sysio.bond.planPrune(
      Report.Actor.Underwriter,
      "bond-prune",
      "push bond::prune",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.PruneInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runPrune)
  })

  it("runPrune pushes bond::prune as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.prune, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondPruneAction = { from_id: 0, limit: 16 }
    await Steps.contracts.sysio.bond.runPrune(
      ctx,
      { kind: "BondContractSteps.PruneInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("sweepyield carries the bond::sweepyield data and binds runSweepyield", () => {
    const data: SysioContracts.SysioBondSweepyieldAction = { token_code: "LIQSOL" }
    const step = Steps.contracts.sysio.bond.planSweepyield(
      Report.Actor.Underwriter,
      "bond-sweepyield",
      "push bond::sweepyield",
      {},
      data,
      CpuPayer
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input).toEqual({ kind: "BondContractSteps.SweepyieldInput", data, signer: CpuPayer })
    expect(step.runner).toBe(Steps.contracts.sysio.bond.runSweepyield)
  })

  it("runSweepyield pushes bond::sweepyield as the CPU payer", async () => {
    const { ctx, contract, getSysioContract } = bondContext(),
      invoke = jest.spyOn(contract.actions.sweepyield, "invoke").mockResolvedValue(undefined),
      data: SysioContracts.SysioBondSweepyieldAction = { token_code: "LIQSOL" }
    await Steps.contracts.sysio.bond.runSweepyield(
      ctx,
      { kind: "BondContractSteps.SweepyieldInput", data, signer: CpuPayer },
      signal
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.bond)
    expect(invoke).toHaveBeenCalledWith(data, signedBy(CpuPayer))
  })

  it("runSetconfig pushes nothing once the step is aborted", async () => {
    const { ctx, contract } = bondContext(),
      invoke = jest.spyOn(contract.actions.setconfig, "invoke").mockResolvedValue(undefined),
      controller = new AbortController(),
      data: SysioContracts.SysioBondSetconfigAction = { hold_bps: 1000 }
    controller.abort()
    await expect(
      Steps.contracts.sysio.bond.runSetconfig(
        ctx,
        { kind: "BondContractSteps.SetconfigInput", data },
        controller.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
