import {
  Steps,
  type ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

/** The depot's `epochstate` query result, typed from the client that returns it. */
type EpochStateQueryResult = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getEpochState"]>
>

/** A `epochstate` singleton read stubbed onto a REAL context's memoized client. */
function contextWithEpochState(
  ...rows: SysioContracts.SysioEpochEpochStateType[]
): ClusterBuildContext {
  const ctx = fixtureContext()
  jest
    .spyOn(ctx.wire, "getEpochState")
    .mockResolvedValue({ rows } as EpochStateQueryResult)
  return ctx
}

/** The schedule window + its rotation cursor — the only fields these reads touch. */
function epochStateRow(
  currentBatchOpGroup: number,
  batchOperatorGroups: string[][]
): SysioContracts.SysioEpochEpochStateType {
  return {
    current_batch_op_group: currentBatchOpGroup,
    batch_op_groups: batchOperatorGroups
  } as SysioContracts.SysioEpochEpochStateType
}

describe("Steps.contracts.sysio.epoch", () => {
  it("setconfig carries the epoch::setconfig data", () => {
    const data: SysioContracts.SysioEpochSetconfigAction = {
      epoch_duration_sec: 60,
      operators_per_epoch: 3,
      batch_operator_minimum_active: 9,
      batch_op_groups: 3,
      epoch_retention_envelope_log_count: 10
    }
    const step = Steps.contracts.sysio.epoch.planSetconfig(
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

  it.each(["planSchbatchgps", "planAdvance"] as const)(
    "%s builds an input-less step with a runner",
    action => {
      const factory = Steps.contracts.sysio.epoch[action]
      const step = factory(Report.Actor.Sysio, action, `crank ${action}`, {})
      expect(step.input).toBeNull()
      expect(typeof step.runner).toBe("function")
    }
  )
})

describe("Steps.contracts.sysio.epoch epochstate reads", () => {
  const groups = [["opa", "opb"], ["opc", "opd"], ["ope", "opf"]]

  it("readEpochState unwraps the singleton row", async () => {
    const row = epochStateRow(0, groups)
    await expect(
      Steps.contracts.sysio.epoch.readEpochState(contextWithEpochState(row))
    ).resolves.toBe(row)
  })

  it("batchOperatorGroups returns the WHOLE sliding window", async () => {
    await expect(
      Steps.contracts.sysio.epoch.batchOperatorGroups(
        contextWithEpochState(epochStateRow(1, groups))
      )
    ).resolves.toEqual(groups)
  })

  it("activeBatchOperatorGroup indexes by the rotation cursor, never [0]", async () => {
    // The window rotates: at cursor 2 the ACTIVE group is the third one. A
    // hardcoded `[0]` would return the expired group and silently pass.
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(
        contextWithEpochState(epochStateRow(2, groups))
      )
    ).resolves.toEqual(groups[2])
  })

  it("tolerates an epoch state that has no row yet", async () => {
    const ctx = contextWithEpochState()
    await expect(
      Steps.contracts.sysio.epoch.batchOperatorGroups(ctx)
    ).resolves.toEqual([])
    await expect(
      Steps.contracts.sysio.epoch.activeBatchOperatorGroup(ctx)
    ).resolves.toBeUndefined()
  })
})
