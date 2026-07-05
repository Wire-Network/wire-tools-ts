import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

describe("Steps.contracts.sysio.msgch", () => {
  it.each(["planBootstrap", "planChkcons"] as const)(
    "%s builds an input-less step with a runner",
    action => {
      const step = Steps.contracts.sysio.msgch[action](
        Report.Actor.Sysio,
        action,
        `crank ${action}`,
        {}
      )
      expect(step.actor).toBe(Report.Actor.Sysio)
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})
