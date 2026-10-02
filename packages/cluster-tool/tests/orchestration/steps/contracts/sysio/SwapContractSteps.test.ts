import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const { SysioContractName, SysioContractAccount } = SysioContracts

describe("Steps.contracts.sysio.swap", () => {
  it("setconfig carries the swap::setconfig data", () => {
    const data: SysioContracts.SysioSwapSetconfigAction = {
      fee_authority: SysioContractAccount[SysioContractName.system],
      system_token: {
        sym: "9,WIRE",
        contract: SysioContractAccount[SysioContractName.token]
      }
    }
    const step = Steps.contracts.sysio.swap.planSetconfig(
      Report.Actor.Sysio,
      "configure-swap",
      "set the swap's fee authority and system token",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("SwapContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.system_token.sym).toBe("9,WIRE")
    expect(typeof step.runner).toBe("function")
  })
})
