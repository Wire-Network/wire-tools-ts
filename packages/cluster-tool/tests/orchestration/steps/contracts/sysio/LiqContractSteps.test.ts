import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

const { SysioLiqChainkind } = SysioContracts

/** The shadow symbol every case below addresses (the depot's 9-decimal frame). */
const ShadowSymbol = "9,LIQSOL"
/** The shadow symbol's code, as `claim` names it. */
const ShadowSymbolCode = "LIQSOL"
/** The holder the user-signed cases act for. */
const Holder = "liq.holder"

describe("Steps.contracts.sysio.liq", () => {
  it("create carries the liq::create data", () => {
    const data: SysioContracts.SysioLiqCreateAction = {
      sym: ShadowSymbol,
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("LIQSOL") }
    }
    const step = Steps.contracts.sysio.liq.planCreate(
      Report.Actor.Sysio,
      "create-shadow-liqsol",
      "open the LIQSOL shadow symbol on sysio.liq",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("LiqContractSteps.CreateInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.sym).toBe(ShadowSymbol)
    expect(typeof step.runner).toBe("function")
  })

  it("setkicker carries the liq::setkicker data", () => {
    const data: SysioContracts.SysioLiqSetkickerAction = { bps: 200 }
    const step = Steps.contracts.sysio.liq.planSetkicker(
      Report.Actor.Sysio,
      "configure-liq-kicker",
      "set the T5 yield kicker",
      {},
      data
    )
    expect(step.input.kind).toBe("LiqContractSteps.SetkickerInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.bps).toBe(200)
    expect(typeof step.runner).toBe("function")
  })

  it("regliqpool carries the liq::regliqpool data", () => {
    const data: SysioContracts.SysioLiqRegliqpoolAction = {
      chain_code: { value: SlugName.from("SOLANA") },
      token_code: { value: SlugName.from("LIQSOL") },
      pair_symbol: "9,LIQSOLP",
      initial_chain_amount: 10_000_000_000,
      initial_wire_amount: 10_000_000_000,
      fee: 30,
      locked_shares: 0,
      conversion_horizon_sec: 30,
      depth_cap_bps: 3000,
      clip_floor: 1000
    }
    const step = Steps.contracts.sysio.liq.planRegliqpool(
      Report.Actor.Sysio,
      "seed-liq-pool-solana-liqsol",
      "seed the LIQSOL/WIRE yield pool",
      {},
      data
    )
    expect(step.input.kind).toBe("LiqContractSteps.RegliqpoolInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.pair_symbol).toBe("9,LIQSOLP")
    expect(typeof step.runner).toBe("function")
  })

  it("sweep carries the liq::sweep data AND the CPU payer, who is the signer", () => {
    // `sweep` is permissionless — the account is not the signer, so the payer
    // rides the step input for the authorization.
    const data: SysioContracts.SysioLiqSweepAction = {
      account: Holder,
      chain_kind: SysioLiqChainkind.CHAIN_KIND_SVM
    }
    const step = Steps.contracts.sysio.liq.planSweep(
      Report.Actor.User,
      "sweep-parked-liqsol",
      "deliver the shadow parked against the holder's link",
      {},
      data,
      Holder
    )
    expect(step.actor).toBe(Report.Actor.User)
    expect(step.input.kind).toBe("LiqContractSteps.SweepInput")
    expect(step.input.data).toBe(data)
    expect(step.input.signer).toBe(Holder)
    expect(typeof step.runner).toBe("function")
  })

  it("claim carries the liq::claim data, whose holder is the signer", () => {
    const data: SysioContracts.SysioLiqClaimAction = {
      holder: Holder,
      sym: ShadowSymbolCode
    }
    const step = Steps.contracts.sysio.liq.planClaim(
      Report.Actor.User,
      "claim-liqsol-yield",
      "claim the WIRE owed to the holder's LIQSOL row",
      {},
      data
    )
    expect(step.input.kind).toBe("LiqContractSteps.ClaimInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.holder).toBe(Holder)
    expect(typeof step.runner).toBe("function")
  })

  it("desyndicate carries the liq::desyndicate data, whose holder is the signer", () => {
    const data: SysioContracts.SysioLiqDesyndicateAction = {
      holder: Holder,
      quantity: "2.000000000 LIQSOL"
    }
    const step = Steps.contracts.sysio.liq.planDesyndicate(
      Report.Actor.User,
      "desyndicate-liqsol",
      "burn the holder's shadow and queue DESYNDICATE_LIQ",
      {},
      data
    )
    expect(step.input.kind).toBe("LiqContractSteps.DesyndicateInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.quantity).toBe("2.000000000 LIQSOL")
    expect(typeof step.runner).toBe("function")
  })
})
