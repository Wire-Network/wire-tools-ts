import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.token", () => {
  it("create carries the token::create data", () => {
    const data: SysioContracts.SysioTokenCreateAction = {
      issuer: "sysio",
      maximum_supply: "1000000000.000000000 WIRE"
    }
    const step = Steps.contracts.sysio.token.create(
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
    const step = Steps.contracts.sysio.token.issue(
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
    const step = Steps.contracts.sysio.token.transfer(
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
})
