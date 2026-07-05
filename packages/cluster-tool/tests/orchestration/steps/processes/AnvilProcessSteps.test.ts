import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.processes.anvil", () => {
  it.each(["planStart", "planEnableIntervalMining"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.processes.anvil[factoryName](
        Report.Actor.EthereumOutpost,
        factoryName,
        `anvil ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.EthereumOutpost)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})
