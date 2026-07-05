import { NodeOwnerTier } from "@wireio/opp-typescript-models"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.roa", () => {
  it("newnameduser carries the roa::newnameduser data", () => {
    const data: SysioContracts.SysioRoaNewnameduserAction = {
      account: "wireno",
      pubkey: "PUB_K1_examplekey",
      tier: NodeOwnerTier.T1
    }
    const step = Steps.contracts.sysio.roa.planNewnameduser(
      Report.Actor.Sysio,
      "create-node-owner",
      "create the bootstrap node owner",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("RoaContractSteps.NewnameduserInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("nodeownreg carries the roa::nodeownreg data", () => {
    const data: SysioContracts.SysioRoaNodeownregAction = {
      owner: "wireno",
      tier: NodeOwnerTier.T1,
      eth_pub_key: "PUB_EM_examplekey",
      wire_pub_key: "PUB_K1_examplekey"
    }
    const step = Steps.contracts.sysio.roa.planNodeownreg(
      Report.Actor.Sysio,
      "register-node-owner",
      "register the bootstrap node owner at tier 1",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("RoaContractSteps.NodeownregInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("activateroa carries the roa::activateroa data", () => {
    const data: SysioContracts.SysioRoaActivateroaAction = {
      total_sys: "1000000000.000000000 SYS",
      bytes_per_unit: 1024
    }
    const step = Steps.contracts.sysio.roa.planActivateroa(
      Report.Actor.Sysio,
      "activate-roa",
      "activate ROA (finite RAM gifting)",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("RoaContractSteps.ActivateroaInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.bytes_per_unit).toBe(1024)
    expect(typeof step.runner).toBe("function")
  })
})
