import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.uwrit", () => {
  it("setconfig carries the uwrit::setconfig data", () => {
    // `sysio.uwrit::setconfig` grew the swap-from-WIRE ingress rails: the
    // escrow floor (`min_fromwire_amount`, 9-dec base units) and the
    // caller-fault drain-revert fee (`fromwire_revert_fee_bps`). The action
    // type requires all four fields — a payload missing the new pair fails
    // chain-side serialization.
    const data: SysioContracts.SysioUwritSetconfigAction = {
      fee_bps: 30,
      collateral_lock_duration_ms: 600_000,
      min_fromwire_amount: 100_000_000,
      fromwire_revert_fee_bps: 10
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
    expect(step.input.data.min_fromwire_amount).toBe(100_000_000)
    expect(step.input.data.fromwire_revert_fee_bps).toBe(10)
    expect(typeof step.runner).toBe("function")
  })
})
