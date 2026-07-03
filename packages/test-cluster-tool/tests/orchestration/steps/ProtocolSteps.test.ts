import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"

describe("Steps.protocol", () => {
  it("activateFeatures builds an input-less step", () => {
    const step = Steps.protocol.planActivateFeatures(
      Report.Actor.Sysio,
      "features",
      "activate protocol features",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("setFinalizer carries the finalizer policy input", () => {
    const step = Steps.protocol.planSetFinalizer(
      Report.Actor.Sysio,
      "finality",
      "BLS instant finality",
      {},
      {
        threshold: 1,
        finalizers: [
          { description: "f0", weight: 1, public_key: "PUB_BLS_x", pop: "SIG_BLS_y" }
        ]
      }
    )
    expect(step.input.kind).toBe("ProtocolSteps.SetFinalizerInput")
    expect(step.input.policy.threshold).toBe(1)
    expect(step.input.policy.finalizers).toHaveLength(1)
  })
})
