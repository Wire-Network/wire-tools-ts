import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.epoch", () => {
  it("setconfig carries the epoch::setconfig data", () => {
    const data: SysioContracts.SysioEpochSetconfigAction = {
      epoch_duration_sec: 60,
      operators_per_epoch: 3,
      batch_operator_minimum_active: 9,
      batch_op_groups: 3,
      epoch_retention_envelope_log_count: 10
    }
    const step = Steps.contracts.sysio.epoch.setconfig(
      Report.Actor.Sysio,
      "configure-epoch",
      "set the global epoch config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("EpochContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it.each(["schbatchgps", "advance"] as const)(
    "%s builds an input-less step with a runner",
    action => {
      const factory = Steps.contracts.sysio.epoch[action]
      const step = factory(Report.Actor.Sysio, action, `crank ${action}`, {})
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})
