import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.consensus", () => {
  it.each(["setFinalizer", "setProducerKeys"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.consensus[factoryName](
        Report.Actor.Sysio,
        factoryName,
        `consensus step ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})
