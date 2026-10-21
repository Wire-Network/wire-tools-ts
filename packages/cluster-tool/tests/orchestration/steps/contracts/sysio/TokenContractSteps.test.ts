import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const { SysioContractName } = SysioContracts

describe("Steps.contracts.sysio.token", () => {
  const signal = new AbortController().signal

  afterEach(() => jest.restoreAllMocks())

  it("create carries the token::create data", () => {
    const data: SysioContracts.SysioTokenCreateAction = {
      issuer: "sysio",
      maximum_supply: "1000000000.000000000 WIRE"
    }
    const step = Steps.contracts.sysio.token.planCreate(
      Report.Actor.Sysio,
      "create-wire",
      "create the WIRE token",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("TokenContractSteps.CreateInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.maximum_supply).toBe("1000000000.000000000 WIRE")
    expect(typeof step.runner).toBe("function")
  })

  it("issue carries the token::issue data", () => {
    const data: SysioContracts.SysioTokenIssueAction = {
      to: "sysio",
      quantity: "1000000000.000000000 WIRE",
      memo: "initial WIRE"
    }
    const step = Steps.contracts.sysio.token.planIssue(
      Report.Actor.Sysio,
      "issue-wire",
      "issue WIRE to sysio",
      {},
      data
    )
    expect(step.input.kind).toBe("TokenContractSteps.IssueInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.to).toBe("sysio")
    expect(typeof step.runner).toBe("function")
  })

  it("transfer carries the token::transfer data", () => {
    const data: SysioContracts.SysioTokenTransferAction = {
      from: "sysio",
      to: "defproducera",
      quantity: "1000.000000000 SYS",
      memo: "producer grant"
    }
    const step = Steps.contracts.sysio.token.planTransfer(
      Report.Actor.Sysio,
      "grant-sys",
      "grant SYS to defproducera",
      {},
      data
    )
    expect(step.input.kind).toBe("TokenContractSteps.TransferInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.to).toBe("defproducera")
    expect(typeof step.runner).toBe("function")
  })

  it("runTransfer signs as the sender, whichever account that is", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.token),
      getSysioContract = jest
        .spyOn(ctx.wire, "getSysioContract")
        .mockReturnValue(contract),
      invoke = jest
        .spyOn(contract.actions.transfer, "invoke")
        .mockResolvedValue(undefined)
    await Promise.all(
      ["sysio", "lco.treasury"].map(from =>
        Steps.contracts.sysio.token.runTransfer(
          ctx,
          {
            kind: "TokenContractSteps.TransferInput",
            data: { from, to: "sysio.dclaim", quantity: "1.000000000 WIRE", memo: "" }
          },
          signal
        )
      )
    )
    expect(getSysioContract).toHaveBeenCalledWith(SysioContractName.token)
    expect(invoke.mock.calls.map(([, options]) => options)).toEqual([
      { authorization: [{ actor: "sysio", permission: "active" }] },
      { authorization: [{ actor: "lco.treasury", permission: "active" }] }
    ])
  })

  it("runTransfer refuses an aborted signal before pushing", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.token),
      aborted = new AbortController()
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    const invoke = jest.spyOn(contract.actions.transfer, "invoke")
    aborted.abort()
    await expect(
      Steps.contracts.sysio.token.runTransfer(
        ctx,
        {
          kind: "TokenContractSteps.TransferInput",
          data: { from: "sysio", to: "sysio.dclaim", quantity: "1.000000000 WIRE", memo: "" }
        },
        aborted.signal
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})
