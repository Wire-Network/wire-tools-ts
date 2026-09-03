import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

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
      standby_bps: 0,
      epoch_log_retention_count: 10,
      pay_cadence_epochs: 1
    }
    const step = Steps.contracts.sysio.system.planSetemitcfg(
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

  it("setinittime builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.system.planSetinittime(
      Report.Actor.Sysio,
      "set-node-rewards-start",
      "anchor node-owner vesting at chain head time",
      {}
    )
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("initt5 builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.system.planInitt5(
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
    const step = Steps.contracts.sysio.system.planInit(
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
    const step = Steps.contracts.sysio.system.planSetpriv(
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
    const step = Steps.contracts.sysio.system.planNewaccount(
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
    const step = Steps.contracts.sysio.system.planSetprodkeys(
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
    const step = Steps.contracts.sysio.system.planUpdateauth(
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

  it("setacctram carries the system::setacctram data", () => {
    const data: SysioContracts.SysioSystemSetacctramAction = {
      account: "defproducera",
      ram_bytes: 1_000_000
    }
    const step = Steps.contracts.sysio.system.planSetacctram(
      Report.Actor.Sysio,
      "setacctram-defproducera",
      "grant defproducera RAM",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.SetacctramInput")
    expect(step.input.data).toBe(data)
    expect(typeof step.runner).toBe("function")
  })

  it.each([
    ["regproducer", "RegproducerInput", { producer: "flowprod", producer_key: DevK1, url: "", location: 0 }],
    ["unregprod", "UnregprodInput", { producer: "flowprod" }]
  ])(
    "%s signs as the PRODUCER named in its own data, not as sysio",
    async (action, kind, data) => {
      // Every producer-lifecycle action is `require_auth(producer)`, so the invoker's default
      // `<contract>@active` (i.e. sysio) is the WRONG signer — and the authorization is derived
      // from the data rather than carried beside it, so the two cannot drift.
      const step = Steps.contracts.sysio.system[
        action === "regproducer" ? "planRegproducer" : "planUnregprod"
      ](Report.Actor.Producer, `${action}-flowprod`, action, {}, data as never)
      expect(step.input.kind).toBe(`SystemContractSteps.${kind}`)

      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.system),
        invoke = jest
          .spyOn(contract.actions[action as "regproducer"], "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await step.runner(ctx, step.input as never, new AbortController().signal)
      expect(invoke).toHaveBeenCalledWith(data, {
        authorization: [{ actor: "flowprod", permission: "active" }]
      })
    }
  )

  it.each([
    ["regfinkey", "RegfinkeyInput", { finalizer_name: "flowprod", finalizer_key: "PUB_BLS_x", proof_of_possession: "SIG_BLS_x" }],
    ["actfinkey", "ActfinkeyInput", { finalizer_name: "flowprod", finalizer_key: "PUB_BLS_x" }]
  ])(
    "%s signs as the FINALIZER named in its own data",
    async (action, kind, data) => {
      const step = Steps.contracts.sysio.system[
        action === "regfinkey" ? "planRegfinkey" : "planActfinkey"
      ](Report.Actor.Producer, `${action}-flowprod`, action, {}, data as never)
      expect(step.input.kind).toBe(`SystemContractSteps.${kind}`)

      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.system),
        invoke = jest
          .spyOn(contract.actions[action as "regfinkey"], "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      await step.runner(ctx, step.input as never, new AbortController().signal)
      expect(invoke).toHaveBeenCalledWith(data, {
        authorization: [{ actor: "flowprod", permission: "active" }]
      })
    }
  )

  it("setscorecfg is governance-signed — it carries NO explicit authorization", async () => {
    // `require_auth(get_self())`, so the invoker's default `sysio@active` is exactly right;
    // passing a producer authorization here would break it.
    const data: SysioContracts.SysioSystemSetscorecfgAction = {
      weights: {
        collateral_weight: 10_000,
        participation_weight: 10_000,
        snapshot_weight: 10_000,
        relay_weight: 0,
        api_weight: 0,
        benchmark_weight: 0,
        max_consecutive_missed_rounds: 3,
        snapshot_target_attestations: 1
      }
    }
    const step = Steps.contracts.sysio.system.planSetscorecfg(
      Report.Actor.Sysio,
      "setscorecfg",
      "set producer score weights",
      {},
      data
    )
    expect(step.input.kind).toBe("SystemContractSteps.SetscorecfgInput")

    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.system),
      invoke = jest
        .spyOn(contract.actions.setscorecfg, "invoke")
        .mockResolvedValue(undefined)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    await step.runner(ctx, step.input, new AbortController().signal)
    expect(invoke).toHaveBeenCalledWith(data)
  })
})
