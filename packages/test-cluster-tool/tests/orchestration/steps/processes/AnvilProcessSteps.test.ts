import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.processes.anvil", () => {
  it.each(["start", "enableIntervalMining"] as const)(
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
