import { OperatorType } from "@wireio/opp-typescript-models"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../../../outputs/operatorAccountFixture.js"

const OperatorLabel = "batchop.a",
  GeneratedAccount = "wireno.x3f9k",
  AuditReason = "test live-group degradation"

function terminateFixture() {
  const ctx = fixtureContext()
  ctx.keyStore.setOperator(
    fixtureOperatorAccount(OperatorLabel, OperatorType.BATCH, GeneratedAccount)
  )
  const contract = ctx.wire.getSysioContract(
      SysioContracts.SysioContractName.opreg
    ),
    invoke = jest
      .spyOn(contract.actions.terminate, "invoke")
      .mockResolvedValue(undefined)
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  return { ctx, invoke }
}

describe("Steps.contracts.sysio.opreg", () => {
  it("setconfig carries the opreg::setconfig data", () => {
    const data: SysioContracts.SysioOpregSetconfigAction = {
      max_available_producers: 21,
      max_available_batch_ops: 63,
      max_available_underwriters: 21,
      terminate_prune_delay_ms: 600_000,
      terminate_max_consecutive_misses: 5,
      terminate_max_pct_misses_24h: 5,
      terminate_window_ms: 86_400_000,
      req_prod_collat: [],
      req_batchop_collat: [],
      req_uw_collat: []
    }
    const step = Steps.contracts.sysio.opreg.planSetconfig(
      Report.Actor.Sysio,
      "configure-opreg",
      "set the operator-registry config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("OpregContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.max_available_batch_ops).toBe(63)
    expect(typeof step.runner).toBe("function")
  })

  it("regoperator carries the opreg::regoperator data", () => {
    const data: SysioContracts.SysioOpregRegoperatorAction = {
      account: "batchop.a",
      type: SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH,
      is_bootstrapped: true
    }
    const step = Steps.contracts.sysio.opreg.planRegoperator(
      Report.Actor.BatchOperator,
      "register-batchop-a",
      "register batchop.a as a bootstrapped batch operator",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.BatchOperator)
    expect(step.input.kind).toBe("OpregContractSteps.RegoperatorInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.is_bootstrapped).toBe(true)
    expect(typeof step.runner).toBe("function")
  })

  it("terminate carries the operator label and audit reason", () => {
    const step = Steps.contracts.sysio.opreg.planTerminate(
      Report.Actor.Sysio,
      "terminate-batchop-a",
      "administratively remove batchop.a",
      {},
      OperatorLabel,
      AuditReason
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("OpregContractSteps.TerminateInput")
    expect(step.input.label).toBe(OperatorLabel)
    expect(step.input.reason).toBe(AuditReason)
    expect(typeof step.runner).toBe("function")
  })

  it("terminate resolves the operator label and invokes the generated account", async () => {
    const { ctx, invoke } = terminateFixture()

    await Steps.contracts.sysio.opreg.runTerminate(
      ctx,
      {
        kind: "OpregContractSteps.TerminateInput",
        label: OperatorLabel,
        reason: AuditReason
      },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith({
      account: GeneratedAccount,
      reason: AuditReason
    })
  })

  it("terminate rejects a pre-aborted signal without resolving or invoking", async () => {
    const { ctx, invoke } = terminateFixture(),
      assertOperator = jest.spyOn(ctx.keyStore, "assertOperator"),
      controller = new AbortController()
    controller.abort()

    await expect(
      Steps.contracts.sysio.opreg.runTerminate(
        ctx,
        {
          kind: "OpregContractSteps.TerminateInput",
          label: OperatorLabel,
          reason: AuditReason
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })

    expect(assertOperator).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
})
