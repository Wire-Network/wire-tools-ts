import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.keys", () => {
  it.each(["planGenerateNodeKeys", "planCreateWallet"] as const)(
    "%s builds an input-less step with a runner",
    factoryName => {
      const step = Steps.keys[factoryName](
        Report.Actor.Sysio,
        factoryName,
        `key step ${factoryName}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})
