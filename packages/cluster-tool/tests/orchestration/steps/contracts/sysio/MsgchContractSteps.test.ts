import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const DeliverData: SysioContracts.SysioMsgchDeliverAction = {
  batch_op_name: "wireno.batcha",
  chain_code: 60,
  data: "aabbcc"
}

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

  it("deliver carries generated action data and binds the canonical runner", () => {
    const step = Steps.contracts.sysio.msgch.planDeliver(
      Report.Actor.BatchOperator,
      "deliver-ethereum",
      "deliver one Ethereum envelope",
      {},
      DeliverData
    )

    expect(step.input).toEqual({
      kind: "MsgchContractSteps.DeliverInput",
      data: DeliverData
    })
    expect(step.runner).toBe(Steps.contracts.sysio.msgch.runDeliver)
  })

  it("deliver signs as the delivering batch operator", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.msgch
      ),
      invoke = jest
        .spyOn(contract.actions.deliver, "invoke")
        .mockResolvedValue(undefined)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

    await Steps.contracts.sysio.msgch.runDeliver(
      ctx,
      { kind: "MsgchContractSteps.DeliverInput", data: DeliverData },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledWith(DeliverData, {
      authorization: [
        { actor: DeliverData.batch_op_name, permission: "active" }
      ]
    })
  })

  it("deliver performs no write when pre-aborted", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.msgch
      ),
      invoke = jest
        .spyOn(contract.actions.deliver, "invoke")
        .mockResolvedValue(undefined),
      controller = new AbortController()
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    controller.abort()

    await expect(
      Steps.contracts.sysio.msgch.runDeliver(
        ctx,
        { kind: "MsgchContractSteps.DeliverInput", data: DeliverData },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(invoke).not.toHaveBeenCalled()
  })
})
