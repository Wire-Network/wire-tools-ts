import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

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
})
