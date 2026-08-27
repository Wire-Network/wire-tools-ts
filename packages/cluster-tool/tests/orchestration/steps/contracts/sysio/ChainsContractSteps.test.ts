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
      description: "The WIRE depot chain itself",
      // The depot self-row has no remote deployment, and outpost rows are
      // registered empty here too — RegistrySteps seeds their addresses with
      // setoutpost once the daemon artifacts resolve.
      outpost: {
        opp_addr: "",
        opp_inbound_addr: "",
        operator_registry_addr: "",
        source_deposit_addr: ""
      }
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
