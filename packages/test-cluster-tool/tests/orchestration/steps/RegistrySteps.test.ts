import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.registry", () => {
  it("seedRegistry builds an input-less step with a runner", () => {
    const step = Steps.registry.seedRegistry(
      Report.Actor.Sysio,
      "seed-registry",
      "register chains + tokens + chain-tokens + reserves",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
