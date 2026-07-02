import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const DevK1 = "PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYq2fJUVgWY7"

const authority: SysioContracts.SysioBiosAuthorityType = {
  threshold: 1,
  keys: [{ key: DevK1, weight: 1 }],
  accounts: []
}

describe("Steps.contracts.sysio.bios", () => {
  it("setfinalizer carries the bios::setfinalizer data", () => {
    const data: SysioContracts.SysioBiosSetfinalizerAction = {
      finalizer_policy: {
        threshold: 1,
        finalizers: [
          {
            description: "node_00",
            weight: 1,
            public_key: "PUB_BLS_node00",
            pop: "SIG_BLS_node00"
          }
        ]
      }
    }
    const step = Steps.contracts.sysio.bios.setfinalizer(
      Report.Actor.Sysio,
      "set-finalizer",
      "set the BLS finalizer policy from node keys",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("BiosContractSteps.SetfinalizerInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("newaccount carries the bios::newaccount data", () => {
    const data: SysioContracts.SysioBiosNewaccountAction = {
      creator: "sysio",
      name: "sysio.roa",
      owner: authority,
      active: authority
    }
    const step = Steps.contracts.sysio.bios.newaccount(
      Report.Actor.Sysio,
      "create-roa",
      "create sysio.roa",
      {},
      data
    )
    expect(step.input.kind).toBe("BiosContractSteps.NewaccountInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.name).toBe("sysio.roa")
    expect(typeof step.runner).toBe("function")
  })

  it("setpriv carries the bios::setpriv data", () => {
    const data: SysioContracts.SysioBiosSetprivAction = {
      account: "sysio.roa",
      is_priv: 1
    }
    const step = Steps.contracts.sysio.bios.setpriv(
      Report.Actor.Sysio,
      "setpriv-roa",
      "mark sysio.roa privileged",
      {},
      data
    )
    expect(step.input.kind).toBe("BiosContractSteps.SetprivInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.is_priv).toBe(1)
    expect(typeof step.runner).toBe("function")
  })

  it("setprodkeys carries the bios::setprodkeys data", () => {
    const data: SysioContracts.SysioBiosSetprodkeysAction = {
      schedule: [{ producer_name: "defproducera", block_signing_key: DevK1 }]
    }
    const step = Steps.contracts.sysio.bios.setprodkeys(
      Report.Actor.Sysio,
      "set-prod-keys",
      "set producer schedule + await handoff",
      {},
      data
    )
    expect(step.input.kind).toBe("BiosContractSteps.SetprodkeysInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })
})
