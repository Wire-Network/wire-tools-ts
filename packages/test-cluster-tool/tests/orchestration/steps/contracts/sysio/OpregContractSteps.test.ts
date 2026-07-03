import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.opreg", () => {
  it("setconfig carries the opreg::setconfig data", () => {
    const data: SysioContracts.SysioOpregSetconfigAction = {
      max_available_producers: 21,
      max_available_batch_ops: 63,
      max_available_underwriters: 21,
      terminate_prune_delay_ms: 600_000,
      terminate_max_consecutive_misses: 5,
      terminate_max_pct_misses_24h: 5,
      terminate_window_ms: 86_400_000,
      req_prod_collat: [],
      req_batchop_collat: [],
      req_uw_collat: []
    }
    const step = Steps.contracts.sysio.opreg.planSetconfig(
      Report.Actor.Sysio,
      "configure-opreg",
      "set the operator-registry config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("OpregContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.max_available_batch_ops).toBe(63)
    expect(typeof step.runner).toBe("function")
  })

  it("regoperator carries the opreg::regoperator data", () => {
    const data: SysioContracts.SysioOpregRegoperatorAction = {
      account: "batchop.a",
      type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
      is_bootstrapped: true
    }
    const step = Steps.contracts.sysio.opreg.planRegoperator(
      Report.Actor.BatchOperator,
      "register-batchop-a",
      "register batchop.a as a bootstrapped batch operator",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.BatchOperator)
    expect(step.input.kind).toBe("OpregContractSteps.RegoperatorInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.is_bootstrapped).toBe(true)
    expect(typeof step.runner).toBe("function")
  })
})
