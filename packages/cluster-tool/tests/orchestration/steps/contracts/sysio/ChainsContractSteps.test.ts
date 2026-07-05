import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.chains", () => {
  it("regchain carries the chains::regchain data", () => {
    const data: SysioContracts.SysioChainsRegchainAction = {
      kind: SysioContracts.SysioChainsChainkind.CHAIN_KIND_WIRE,
      code: { value: SlugName.from("WIRE") },
      external_chain_id: 0,
      name: "Wire (depot)",
      description: "The WIRE depot chain itself"
    }
    const step = Steps.contracts.sysio.chains.planRegchain(
      Report.Actor.Sysio,
      "register-wire",
      "register the WIRE depot chain",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("ChainsContractSteps.RegchainInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.kind).toBe(
      SysioContracts.SysioChainsChainkind.CHAIN_KIND_WIRE
    )
    expect(typeof step.runner).toBe("function")
  })
})
