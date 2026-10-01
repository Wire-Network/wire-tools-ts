import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

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
      chain_code: "SOLANA",
      token_code: "LIQSOL"
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
      chain_code: "SOLANA",
      token_code: "LIQSOL",
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

  it("recredit carries the liq::recredit data and binds runRecredit", () => {
    const data: SysioContracts.SysioLiqRecreditAction = {
      holder: Holder,
      quantity: "2.000000000 LIQSOL"
    }
    const step = Steps.contracts.sysio.liq.planRecredit(
      Report.Actor.Sysio,
      "recredit-liqsol",
      "return a skipped desyndication's shadow to the holder",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toEqual({ kind: "LiqContractSteps.RecreditInput", data })
    expect(step.runner).toBe(Steps.contracts.sysio.liq.runRecredit)
  })

  describe("runRecredit", () => {
    const data: SysioContracts.SysioLiqRecreditAction = {
      holder: Holder,
      quantity: "2.000000000 LIQSOL"
    }

    /** A fixture context whose `getSysioContract` hands back one shared `sysio.liq` client. */
    function liqContext() {
      const ctx = fixtureContext(),
        contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.liq)
      jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
      return { ctx, contract }
    }

    afterEach(() => jest.restoreAllMocks())

    it("pushes liq::recredit under the contract's own authority", async () => {
      const { ctx, contract } = liqContext(),
        invoke = jest.spyOn(contract.actions.recredit, "invoke").mockResolvedValue(undefined)
      await Steps.contracts.sysio.liq.runRecredit(
        ctx,
        { kind: "LiqContractSteps.RecreditInput", data },
        new AbortController().signal
      )
      expect(invoke).toHaveBeenCalledWith(data)
    })

    it("pushes nothing once the step is aborted", async () => {
      const { ctx, contract } = liqContext(),
        invoke = jest.spyOn(contract.actions.recredit, "invoke").mockResolvedValue(undefined),
        controller = new AbortController()
      controller.abort()
      await expect(
        Steps.contracts.sysio.liq.runRecredit(
          ctx,
          { kind: "LiqContractSteps.RecreditInput", data },
          controller.signal
        )
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
