import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.contracts.sysio.dclaim", () => {
  it("setconfig builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.dclaim.planSetconfig(
      Report.Actor.Sysio,
      "init-dclaim",
      "initialize the dclaim cap_config",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
