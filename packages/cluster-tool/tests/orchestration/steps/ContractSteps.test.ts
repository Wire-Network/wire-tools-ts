import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const { SysioContractName } = SysioContracts

describe("Steps.contract.deploy", () => {
  it("builds a deploy step with the contract + default system (setsyscode) mode", () => {
    const step = Steps.contract.planDeploy(
      Report.Actor.Sysio,
      "deploy-epoch",
      "deploy sysio.epoch",
      {},
      SysioContractName.epoch
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.name).toBe("deploy-epoch")
    expect(step.input.kind).toBe("ContractSteps.DeployInput")
    expect(step.input.contract).toBe(SysioContractName.epoch)
    expect(step.input.mode).toBe(Steps.contract.DeployMode.system)
  })

  it("honors raw mode (bios/system/roa, pre-ROA)", () => {
    const step = Steps.contract.planDeploy(
      Report.Actor.Sysio,
      "deploy-bios",
      "deploy sysio.bios raw",
      {},
      SysioContractName.bios,
      Steps.contract.DeployMode.raw
    )
    expect(step.input.mode).toBe(Steps.contract.DeployMode.raw)
    expect(step.input.contract).toBe(SysioContractName.bios)
  })
})

describe("Steps.contract.grantSysioCode", () => {
  it("carries the target account as typed input", () => {
    const step = Steps.contract.planGrantSysioCode(
      Report.Actor.Sysio,
      "grant-opreg",
      "sysio.opreg gets @sysio.code",
      {},
      "sysio.opreg"
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("ContractSteps.GrantSysioCodeInput")
    expect(step.input.account).toBe("sysio.opreg")
    expect(typeof step.runner).toBe("function")
  })
})

describe("Steps.contract.verifyPrivileged", () => {
  function step() {
    return Steps.contract.planVerifyPrivileged(
      Report.Actor.Sysio,
      "verify-kicker-privileged",
      "sysio.kicker is privileged",
      {},
      "sysio.kicker"
    )
  }

  /** A context whose chain answers `privileged` for every account. */
  function contextWith(privileged: boolean) {
    const isPrivileged = jest.fn(async (_account: string) => privileged)
    return { ctx: { wire: { isPrivileged } } as never, isPrivileged }
  }

  it("carries the target account as typed input", () => {
    const verify = step()
    expect(verify.actor).toBe(Report.Actor.Sysio)
    expect(verify.input.kind).toBe("ContractSteps.VerifyPrivilegedInput")
    expect(verify.input.account).toBe("sysio.kicker")
  })

  it("passes when the chain marks the account privileged", async () => {
    const verify = step(),
      { ctx, isPrivileged } = contextWith(true)
    await expect(
      Steps.contract.runVerifyPrivileged(ctx, verify.input, new AbortController().signal)
    ).resolves.toBeUndefined()
    expect(isPrivileged).toHaveBeenCalledWith("sysio.kicker")
  })

  it("fails, naming the account, when it is not privileged", async () => {
    const verify = step(),
      { ctx } = contextWith(false)
    await expect(
      Steps.contract.runVerifyPrivileged(ctx, verify.input, new AbortController().signal)
    ).rejects.toThrow("sysio.kicker is not privileged")
  })
})
