import { SlugName } from "@wireio/sdk-core"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

/** A fresh build root (a `ClusterBuildParent`) for the reserve phase to register on. */
function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("registry-test"))
  )
}

describe("Steps.registry", () => {
  it("seedRegistry builds an input-less step with a runner", () => {
    const step = Steps.registry.planSeedRegistry(
      Report.Actor.Sysio,
      "seed-registry",
      "register chains + tokens + chain-tokens",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  describe("planMockReserves", () => {
    const PrimaryCode = SlugName.from("PRIMARY")
    const StableCode = SlugName.from("USDC")
    const NativeCode = SlugName.from("ETH")
    // ReserveSeedAmount 10_000_000_000; stablecoins ÷1000 at precision 6, others precision 9.
    const FullChainSeed = 10_000_000_000
    const StableChainSeed = 10_000_000
    const ConnectorWeightBps = 5000

    it("returns a Phase of 8 static Sysio regreserve steps", () => {
      const phase = Steps.registry.planMockReserves(
        newBuild(),
        "MockReserves",
        "seed mock reserves",
        {}
      )
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps).toHaveLength(8)
      expect(
        phase.steps.every(step => step.actor === Report.Actor.Sysio)
      ).toBe(true)
    })

    it("names each step seed-reserve-<chain>-<token>, all unique", () => {
      const phase = Steps.registry.planMockReserves(
        newBuild(),
        "MockReserves",
        "d",
        {}
      )
      const names = phase.steps.map(step => step.name)
      expect(new Set(names).size).toBe(8)
      expect(names).toContain("seed-reserve-ethereum-eth")
      expect(names).toContain("seed-reserve-solana-usdcsol")
    })

    it("carries a RegreserveInput with PRIMARY code + 5000 connector on every row", () => {
      const phase = Steps.registry.planMockReserves(
        newBuild(),
        "MockReserves",
        "d",
        {}
      )
      phase.steps.forEach(step => {
        expect(step.input.kind).toBe("ReservContractSteps.RegreserveInput")
        expect(step.input.data.reserve_code.value).toBe(PrimaryCode)
        expect(step.input.data.connector_weight_bps).toBe(ConnectorWeightBps)
        expect(step.input.data.is_private).toBe(false)
      })
    })

    it("seeds stablecoins at precision 6 with a ÷1000 chain seed, others at full/9", () => {
      const rows = Steps.registry.MockReserveRegistrations
      expect(rows).toHaveLength(8)
      const stable = rows.find(row => row.token_code.value === StableCode)
      const native = rows.find(row => row.token_code.value === NativeCode)
      expect(stable?.source_token_precision).toBe(6)
      expect(stable?.initial_chain_amount).toBe(StableChainSeed)
      expect(stable?.initial_wire_amount).toBe(FullChainSeed)
      expect(native?.source_token_precision).toBe(9)
      expect(native?.initial_chain_amount).toBe(FullChainSeed)
    })
  })
})
