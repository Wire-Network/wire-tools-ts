import {
  OrchestrationContext,
  outputKey
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"

describe("OrchestrationContext", () => {
  it("carries report configuration, outputs, and completed phases", () => {
    const context = new OrchestrationContext(
      {
        report: {
          path: "/tmp/readiness-report",
          basename: "readiness",
          formats: []
        }
      },
      getLogger("orchestration-context-test")
    )
    const phase: Report.Phase = {
      kind: Report.NodeKind.phase,
      name: "identity",
      description: "identity",
      steps: [],
      succeeded: true,
      durationMs: 1
    }

    const observedChain = outputKey<string>("observed-chain", "observed chain")
    context.outputs.set(observedChain, "chain-id")
    context.completedPhases.push(phase)

    expect(context.config.report.basename).toBe("readiness")
    expect(context.outputs.assert(observedChain)).toBe("chain-id")
    expect(context.completedPhases).toEqual([phase])
  })
})
