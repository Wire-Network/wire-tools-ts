import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.processes.nodeop", () => {
  it("start carries the target node name as typed input", () => {
    const step = Steps.processes.nodeop.start(
      Report.Actor.Producer,
      "start-node_00",
      "start node_00",
      {},
      "node_00"
    )
    expect(step.actor).toBe(Report.Actor.Producer)
    expect(step.input.kind).toBe("NodeopProcessSteps.StartInput")
    expect(step.input.nodeName).toBe("node_00")
    expect(typeof step.runner).toBe("function")
  })

  it("restart carries the target node name as typed input", () => {
    const step = Steps.processes.nodeop.restart(
      Report.Actor.Underwriter,
      "restart-node_04",
      "relaunch node_04 after sync",
      {},
      "node_04"
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.input.kind).toBe("NodeopProcessSteps.RestartInput")
    expect(step.input.nodeName).toBe("node_04")
    expect(typeof step.runner).toBe("function")
  })
})
