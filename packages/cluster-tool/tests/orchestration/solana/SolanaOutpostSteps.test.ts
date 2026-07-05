import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.solanaOutpost.deploy", () => {
  it("builds an input-less deploy step with a runner", () => {
    const step = Steps.solanaOutpost.planDeploy(
      Report.Actor.SolanaOutpost,
      "deploy-solana-outpost",
      "deploy the Solana outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
