import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.operator.register", () => {
  it("carries the regoperator action data", () => {
    const data: SysioContracts.SysioOpregRegoperatorAction = {
      account: "batchopaaaa",
      type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
      is_bootstrapped: true
    }
    const step = Steps.operator.planRegister(
      Report.Actor.BatchOperator,
      "register-batchop",
      "register a bootstrapped batch operator",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.BatchOperator)
    expect(step.input.kind).toBe("OperatorSteps.RegisterInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })
})
