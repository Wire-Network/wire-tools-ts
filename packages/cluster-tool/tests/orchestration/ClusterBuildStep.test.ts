import {
  ClusterBuildContext,
  ClusterBuildStep,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

interface DeployInput extends StepInput {
  kind: "DeployInput"
  contract: string
}

describe("ClusterBuildStep.create", () => {
  it("stores the actor-first definition + typed input + runner", () => {
    const step = ClusterBuildStep.create<ClusterBuildContext, DeployInput>(
      Report.Actor.Sysio,
      "deploy",
      "deploy a contract",
      { timeoutMs: 5 },
      { kind: "DeployInput", contract: "opreg" },
      async () => {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.name).toBe("deploy")
    expect(step.options.timeoutMs).toBe(5)
    expect(step.input).toEqual({ kind: "DeployInput", contract: "opreg" })
    expect(typeof step.runner).toBe("function")
  })

  it("structurally satisfies Report.StepLike", () => {
    const step = ClusterBuildStep.create(
      Report.Actor.User,
      "s",
      "describe s",
      {},
      null,
      async () => {}
    )
    const like: Report.StepLike = step
    expect(like.actor).toBe(Report.Actor.User)
    expect(like.description).toBe("describe s")
    expect(like.input).toBeNull()
  })
})
