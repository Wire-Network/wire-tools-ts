import { Steps } from "@wireio/test-cluster-tool/orchestration"
import { Report } from "@wireio/test-cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"

const DevK1 = "PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYq2fJUVgWY7"

const authority: SysioContracts.SysioSystemAuthorityType = {
  threshold: 1,
  keys: [{ key: DevK1, weight: 1 }],
  accounts: []
}

describe("Steps.contracts.sysio.system", () => {
  it("setemitcfg carries the emission-config struct (invoked as { cfg })", () => {
    const data: SysioContracts.SysioSystemEmissionConfigType = {
      t1_allocation: 0,
      t2_allocation: 0,
      t3_allocation: 0,
      t1_duration: 0,
      t2_duration: 0,
      t3_duration: 0,
      min_claimable: 0,
      t5_distributable: 0,
      t5_floor: 0,
      target_annual_decay_bps: 0,
      annual_initial_emission: 0,
      annual_max_emission: 0,
      annual_min_emission: 0,
      compute_bps: 5000,
      capex_bps: 1000,
      governance_bps: 1000,
      producer_bps: 0,
      batch_op_bps: 0,
      standby_end_rank: 0,
      epoch_log_retention_count: 10,
      pay_cadence_epochs: 1
    }
    const step = Steps.contracts.sysio.system.setemitcfg(
      Report.Actor.Sysio,
      "set-emit-config",
      "set the emission config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("SystemContractSteps.SetemitcfgInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.compute_bps).toBe(5000)
    expect(typeof step.runner).toBe("function")
  })

  it("initt5 builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.system.initt5(
      Report.Actor.Sysio,
      "init-t5",
      "seed t5_state at chain head time",
      {}
    )
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("init carries the system::init data", () => {
    const data: SysioContracts.SysioSystemInitAction = {
      version: 0,
      core: "9,SYS"
    }
    const step = Steps.contracts.sysio.system.init(
      Report.Actor.Sysio,
      "system-init",
      "initialize sysio.system",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.InitInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("setpriv carries the system::setpriv data", () => {
    const data: SysioContracts.SysioSystemSetprivAction = {
      account: "sysio.roa",
      is_priv: 1
    }
    const step = Steps.contracts.sysio.system.setpriv(
      Report.Actor.Sysio,
      "setpriv-roa",
      "mark sysio.roa privileged",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.SetprivInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("newaccount carries the system::newaccount data", () => {
    const data: SysioContracts.SysioSystemNewaccountAction = {
      creator: "sysio",
      name: "sysio.bpay",
      owner: authority,
      active: authority
    }
    const step = Steps.contracts.sysio.system.newaccount(
      Report.Actor.Sysio,
      "create-bpay",
      "create sysio.bpay",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.NewaccountInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("setprodkeys carries the system::setprodkeys data", () => {
    const data: SysioContracts.SysioSystemSetprodkeysAction = {
      schedule: [{ producer_name: "defproducera", block_signing_key: DevK1 }]
    }
    const step = Steps.contracts.sysio.system.setprodkeys(
      Report.Actor.Sysio,
      "set-prod-keys",
      "set the producer schedule",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.SetprodkeysInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it("updateauth carries the data + the explicit authorization", () => {
    const data: SysioContracts.SysioSystemUpdateauthAction = {
      account: "sysio.opreg",
      permission: "active",
      parent: "owner",
      auth: authority,
      authorized_by: null
    }
    const authorization = [{ actor: "sysio.opreg", permission: "owner" }]
    const step = Steps.contracts.sysio.system.updateauth(
      Report.Actor.Sysio,
      "grant-opreg-code",
      "grant @sysio.code to sysio.opreg",
      {},
      data,
      authorization
    )
    expect(step.input.kind).toBe("SystemContractSteps.UpdateauthInput")
    expect(step.input.data).toBe(data)
    expect(step.input.authorization).toBe(authorization)
    expect(typeof step.runner).toBe("function")
  })
})
