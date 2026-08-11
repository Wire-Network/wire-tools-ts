import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

describe("Steps.contracts.sysio.reserv", () => {
  it("regreserve carries the reserv::regreserve data", () => {
    const data: SysioContracts.SysioReservRegreserveAction = {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("ETH") },
      reserve_code: { value: SlugName.from("PRIMARY") },
      name: "ETHEREUM-ETH/WIRE primary reserve",
      description: "Bootstrap-seeded native ETH ↔ WIRE reserve",
      initial_chain_amount: 10_000_000_000,
      initial_wire_amount: 10_000_000_000,
      source_token_precision: 9,
      connector_weight_bps: 5000,
      is_private: false,
      owner: ""
    }
    const step = Steps.contracts.sysio.reserv.planRegreserve(
      Report.Actor.Sysio,
      "seed-ethereum-eth",
      "seed the ETHEREUM-ETH/WIRE primary reserve",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("ReservContractSteps.RegreserveInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.connector_weight_bps).toBe(5000)
    expect(typeof step.runner).toBe("function")
  })

  it("setconfig carries the reserv::setconfig fee-routing data", () => {
    // Stage 2 of the swap-fee split: the share of each fee's rewards pool sent
    // to the emissions treasury instead of the batch-operator rewards bucket.
    const data: SysioContracts.SysioReservSetconfigAction = {
      fee_emissions_share_bps: 0
    }
    const step = Steps.contracts.sysio.reserv.planSetconfig(
      Report.Actor.Sysio,
      "configure-reserv",
      "set the swap-fee routing config",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("ReservContractSteps.SetconfigInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.fee_emissions_share_bps).toBe(0)
    expect(typeof step.runner).toBe("function")
  })

  it("setconfig accepts a non-zero emissions share", () => {
    const step = Steps.contracts.sysio.reserv.planSetconfig(
      Report.Actor.Sysio,
      "configure-reserv",
      "route half the rewards pool to the treasury",
      {},
      { fee_emissions_share_bps: 5_000 }
    )
    expect(step.input.data.fee_emissions_share_bps).toBe(5_000)
  })

  describe("runSetconfig", () => {
    const signal = new AbortController().signal

    function setup(actions: string[]) {
      const ctx = fixtureContext()
      jest.spyOn(ctx.wire.api.v1.chain, "get_abi").mockResolvedValue({
        account_name: "sysio.reserv",
        abi: {
          version: "sysio::abi/1.2",
          types: [],
          variants: [],
          structs: [],
          actions: actions.map(name => ({
            name,
            type: name,
            ricardian_contract: ""
          })),
          tables: [],
          ricardian_clauses: [],
          action_results: [],
          enums: []
        }
      })
      const getSysioContract = jest.spyOn(ctx.wire, "getSysioContract")
      return { ctx, getSysioContract }
    }

    it("treats missing setconfig as a legacy-compatible no-op for zero routing", async () => {
      const { ctx, getSysioContract } = setup(["regreserve"])
      const step = Steps.contracts.sysio.reserv.planSetconfig(
        Report.Actor.Sysio,
        "configure-reserv",
        "set the swap-fee routing config",
        {},
        { fee_emissions_share_bps: 0 }
      )

      await step.runner(ctx, step.input, signal)

      expect(getSysioContract).not.toHaveBeenCalled()
    })

    it("rejects non-zero routing when the deployed reserve ABI cannot configure it", async () => {
      const { ctx, getSysioContract } = setup(["regreserve"])
      const step = Steps.contracts.sysio.reserv.planSetconfig(
        Report.Actor.Sysio,
        "configure-reserv",
        "set the swap-fee routing config",
        {},
        { fee_emissions_share_bps: 5_000 }
      )

      await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
        "non-zero fee emissions routing cannot be configured"
      )
      expect(getSysioContract).not.toHaveBeenCalled()
    })
  })

  /** The reserve triple both owner-fee actions address. */
  const reserveTriple = {
    chain_code: { value: SlugName.from("ETHEREUM") },
    token_code: { value: SlugName.from("ETH") },
    reserve_code: { value: SlugName.from("PRIVATE") }
  }

  it("setrsvfee carries the rate AND the owner, who is the required signer", () => {
    // The owner is NOT part of the action data — the contract reads it off the
    // row — so the step input carries it for the authorization.
    const data: SysioContracts.SysioReservSetrsvfeeAction = {
      ...reserveTriple,
      owner_fee_bps: 100
    }
    const step = Steps.contracts.sysio.reserv.planSetrsvfee(
      Report.Actor.User,
      "set-ethereum-reserve-fee",
      "owner charges 100 bps on the private ETH reserve",
      {},
      data,
      "privowner"
    )
    expect(step.actor).toBe(Report.Actor.User)
    expect(step.input.kind).toBe("ReservContractSteps.SetrsvfeeInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.owner_fee_bps).toBe(100)
    expect(step.input.owner).toBe("privowner")
    expect(typeof step.runner).toBe("function")
  })

  it("setrsvfee carries a zero rate — the disable case", () => {
    const step = Steps.contracts.sysio.reserv.planSetrsvfee(
      Report.Actor.User,
      "clear-reserve-fee",
      "owner stops charging",
      {},
      { ...reserveTriple, owner_fee_bps: 0 },
      "privowner"
    )
    expect(step.input.data.owner_fee_bps).toBe(0)
    expect(step.input.owner).toBe("privowner")
  })

  it("claimrsvfee carries the reserve triple AND the owner", () => {
    const data: SysioContracts.SysioReservClaimrsvfeeAction = {
      ...reserveTriple
    }
    const step = Steps.contracts.sysio.reserv.planClaimrsvfee(
      Report.Actor.User,
      "claim-ethereum-reserve-fee",
      "owner claims the private ETH reserve's accrued owner fee",
      {},
      data,
      "privowner"
    )
    expect(step.input.kind).toBe("ReservContractSteps.ClaimrsvfeeInput")
    expect(step.input.data).toBe(data)
    expect(step.input.owner).toBe("privowner")
    expect(typeof step.runner).toBe("function")
  })
})
