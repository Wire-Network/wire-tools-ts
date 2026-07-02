import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.processes.kiod", () => {
  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.kiod.start(
      Report.Actor.Sysio,
      "start-kiod",
      "start the kiod wallet daemon",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
