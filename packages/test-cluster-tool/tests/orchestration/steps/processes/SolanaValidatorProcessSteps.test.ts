import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.processes.solanaValidator", () => {
  it("start builds an input-less step with a runner", () => {
    const step = Steps.processes.solanaValidator.planStart(
      Report.Actor.SolanaOutpost,
      "start-validator",
      "start solana-test-validator + opp-outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
