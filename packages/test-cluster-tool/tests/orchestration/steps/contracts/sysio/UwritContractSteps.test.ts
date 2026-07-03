import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.uwrit", () => {
  it("setconfig carries the uwrit::setconfig data", () => {
    const data: SysioContracts.SysioUwritSetconfigAction = {
      fee_bps: 30,
      collateral_lock_duration_ms: 600_000
    }
    const step = Steps.contracts.sysio.uwrit.planSetconfig(
      Report.Actor.Sysio,
      "configure-uwrit",
      "set the underwriter config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("UwritContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.fee_bps).toBe(30)
    expect(typeof step.runner).toBe("function")
  })
})
