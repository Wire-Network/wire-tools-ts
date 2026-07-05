import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.ethereumOutpost.deploy", () => {
  it("builds an input-less deploy step with a runner", () => {
    const step = Steps.ethereumOutpost.planDeploy(
      Report.Actor.EthereumOutpost,
      "deploy-ethereum-outpost",
      "deploy the Ethereum outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})
