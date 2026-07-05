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
