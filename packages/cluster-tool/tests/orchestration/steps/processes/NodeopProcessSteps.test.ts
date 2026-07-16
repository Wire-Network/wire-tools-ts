import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

describe("Steps.processes.nodeop", () => {
  it("start carries the target node name as typed input", () => {
    const step = Steps.processes.nodeop.planStart(
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
    const step = Steps.processes.nodeop.planRestart(
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

  it("start delegates to NodeopProcess.startWithRecovery (dirty-chainbase resilient)", async () => {
    const ctx = fixtureContext()
    // The context's processManager getter requires the singleton's cluster
    // path to be set (idempotent for the same value).
    ProcessManager.setClusterPath(ctx.config.clusterPath)
    const bios = NodeConfig.plan(ctx.config).find(
      planned => planned.role === NodeRole.bios
    )
    const recoverySpy = jest
      .spyOn(NodeopProcess, "startWithRecovery")
      .mockResolvedValue(undefined as unknown as NodeopProcess)
    try {
      await Steps.processes.nodeop.runStart(
        ctx,
        { kind: "NodeopProcessSteps.StartInput", nodeName: bios.name },
        new AbortController().signal
      )
      expect(recoverySpy).toHaveBeenCalledWith(
        ctx.processManager,
        expect.objectContaining({
          node: expect.objectContaining({ name: bios.name, role: NodeRole.bios })
        })
      )
    } finally {
      recoverySpy.mockRestore()
    }
  })
})
