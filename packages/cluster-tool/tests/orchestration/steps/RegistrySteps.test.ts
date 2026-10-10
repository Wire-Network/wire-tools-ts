import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { ProtocolTiming } from "@wireio/cluster-tool/Constants"
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

  describe("planShadowLiqTokens", () => {
    const LiqethCode = "LIQETH"
    const SolanaCode = "SOLANA"

    it("returns a Phase of one Sysio create step per liq token", () => {
      const phase = Steps.registry.planShadowLiqTokens(
        newBuild(),
        "ShadowLiqTokens",
        "open the shadow symbols",
        {}
      )
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps).toHaveLength(2)
      expect(phase.steps.every(step => step.actor === Report.Actor.Sysio)).toBe(
        true
      )
      expect(phase.steps.map(step => step.name)).toEqual([
        "create-shadow-liqeth",
        "create-shadow-liqsol"
      ])
      phase.steps.forEach(step => {
        expect(step.input.kind).toBe("LiqContractSteps.CreateInput")
      })
    })

    it("opens each shadow at the liq precision, bound to its own chain and token", () => {
      const rows = Steps.registry.ShadowLiqTokenRegistrations
      expect(rows).toHaveLength(2)
      const liqeth = rows.find(row => row.token_code === LiqethCode)
      expect(liqeth?.sym).toBe("9,LIQETH")
      expect(liqeth?.chain_code).toBe("ETHEREUM")
      const liqsol = rows.find(row => row.chain_code === SolanaCode)
      expect(liqsol?.sym).toBe("9,LIQSOL")
      expect(liqsol?.token_code).toBe("LIQSOL")
    })
  })

  describe("planMockLiqPools", () => {
    const LiqsolCode = "LIQSOL"
    // The dev-config seeds; the pacing is the dev cluster's own (one-tick sales).
    const PoolSeed = 10_000_000_000
    const PoolFee = 30
    const HorizonSec = 30
    const DepthCapBps = 3000
    const ClipFloor = 1000

    it("returns a Phase of one Sysio regliqpool step per shadow", () => {
      const phase = Steps.registry.planMockLiqPools(
        newBuild(),
        "MockLiqPools",
        "seed the mock yield pools",
        {}
      )
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps).toHaveLength(2)
      expect(phase.steps.every(step => step.actor === Report.Actor.Sysio)).toBe(
        true
      )
      expect(phase.steps.map(step => step.name)).toEqual([
        "seed-liq-pool-ethereum-liqeth",
        "seed-liq-pool-solana-liqsol"
      ])
      phase.steps.forEach(step => {
        expect(step.input.kind).toBe("LiqContractSteps.RegliqpoolInput")
      })
    })

    it("names each pair token after its shadow, seeds both legs equally, and paces for one-tick sales", () => {
      const rows = Steps.registry.MockLiqPoolRegistrations
      expect(rows).toHaveLength(2)
      const liqsol = rows.find(row => row.token_code === LiqsolCode)
      expect(liqsol?.pair_symbol).toBe("9,LIQSOLP")
      expect(liqsol?.chain_code).toBe("SOLANA")
      expect(liqsol?.initial_chain_amount).toBe(PoolSeed)
      expect(liqsol?.initial_wire_amount).toBe(PoolSeed)
      expect(liqsol?.fee).toBe(PoolFee)
      expect(liqsol?.locked_shares).toBe(0)
      expect(liqsol?.conversion_horizon_sec).toBe(HorizonSec)
      expect(liqsol?.depth_cap_bps).toBe(DepthCapBps)
      expect(liqsol?.clip_floor).toBe(ClipFloor)
      expect(rows.find(row => row.pair_symbol === "9,LIQETHP")).toBeDefined()
    })
  })

  describe("planKicker", () => {
    it("deploys sysio.kicker through setsyscode, reads its privilege back, then configures it", () => {
      const phase = Steps.registry.planKicker(
        newBuild(),
        "Kicker",
        "deploy and configure the kicker",
        {}
      )
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps.map(step => step.name)).toEqual([
        "deploy-kicker",
        "verify-kicker-privileged",
        "configure-kicker"
      ])
      expect(phase.steps.every(step => step.actor === Report.Actor.Sysio)).toBe(true)
      const [deploy, privileged, configure] = phase.steps
      expect(deploy.input).toEqual(
        expect.objectContaining({
          kind: "ContractSteps.DeployInput",
          contract: "kicker",
          mode: Steps.contract.DeployMode.system
        })
      )
      expect(privileged.input).toEqual({
        kind: "ContractSteps.VerifyPrivilegedInput",
        account: "sysio.kicker"
      })
      expect(configure.input).toEqual({
        kind: "KickerContractSteps.SetconfigInput",
        data: Steps.registry.KickerConfiguration
      })
    })

    it("configures a one-million-WIRE budget and a one-minute minimum interval", () => {
      expect(Steps.registry.KickerConfiguration).toEqual({
        cfg: { budget_remaining: 1_000_000_000_000_000, min_interval_sec: 60 }
      })
    })
  })

  describe("planKickerPools", () => {
    it("adds one pool per shadow at the contract defaults: 200 bps, one-WIRE minimum, no daily ceiling", () => {
      expect(Steps.registry.KickerPoolRegistrations).toEqual([
        { sym: "LIQETH", rate_bps: 200, min_gift: 1_000_000_000, max_gift_per_day: 0 },
        { sym: "LIQSOL", rate_bps: 200, min_gift: 1_000_000_000, max_gift_per_day: 0 }
      ])
    })

    it("returns a Phase of one Sysio addpool step per shadow", () => {
      const phase = Steps.registry.planKickerPools(
        newBuild(),
        "KickerPools",
        "start each token's accrual",
        {}
      )
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps.map(step => step.name)).toEqual([
        "add-kicker-pool-liqeth",
        "add-kicker-pool-liqsol"
      ])
      phase.steps.forEach((step, index) => {
        expect(step.actor).toBe(Report.Actor.Sysio)
        expect(step.input).toEqual({
          kind: "KickerContractSteps.AddpoolInput",
          data: Steps.registry.KickerPoolRegistrations[index]
        })
      })
    })
  })
})

describe("Steps.registry — underwriting and syndication configuration", () => {
  describe("SyndicationConfigRegistrations", () => {
    const rows = Steps.registry.SyndicationConfigRegistrations

    it("configures every shadow pair: ETHEREUM/LIQETH and SOLANA/LIQSOL", () => {
      expect(rows.map(row => [row.chain_code, row.token_code])).toEqual([
        ["ETHEREUM", "LIQETH"],
        ["SOLANA", "LIQSOL"]
      ])
    })

    it("charges no bootstrap fee and posts no bounty", () => {
      rows.forEach(row => {
        expect(row.synd_fee_bps).toBe(0)
        expect(row.desynd_fee_bps).toBe(0)
        expect(row.bounty).toBe(0)
      })
    })

    it("sets both buckets far above any flow's amount, refilling in full each epoch", () => {
      rows.forEach(row => {
        expect(row.synd_burst).toBe(Steps.registry.SyndicationBucketSize)
        expect(row.synd_refill).toBe(Steps.registry.SyndicationBucketSize)
        expect(row.desynd_burst).toBe(Steps.registry.SyndicationBucketSize)
        expect(row.desynd_refill).toBe(Steps.registry.SyndicationBucketSize)
        expect(Number(row.synd_burst)).toBeGreaterThan(0)
      })
    })

    it("uses the same 0.001 SOL equivalent gross minimum for both shadow tokens", () => {
      expect(Steps.registry.MinimumDesyndication).toBe(1_000_000)
      rows.forEach(row =>
        expect(row.min_desyndicate).toBe(Steps.registry.MinimumDesyndication)
      )
    })

    it("takes the challenge window from ProtocolTiming and a non-zero challenge charge", () => {
      rows.forEach(row => {
        expect(row.window_sec).toBe(
          ProtocolTiming.SyndicationChallengeWindowSec
        )
        expect(Number(row.challenge_extra)).toBeGreaterThan(0)
      })
    })

    it("keeps every amount within an asset's range", () => {
      const AssetAmountMax = 2n ** 62n - 1n
      rows.forEach(row => {
        ;[
          row.synd_burst,
          row.synd_refill,
          row.desynd_burst,
          row.desynd_refill,
          row.challenge_extra
        ].forEach(amount =>
          expect(BigInt(amount)).toBeLessThanOrEqual(AssetAmountMax)
        )
      })
    })
  })

  describe("planSyndicationConfig", () => {
    const phase = Steps.registry.planSyndicationConfig(
      newBuild(),
      "SyndicationConfig",
      "configure sysio.bond + sysio.synd",
      {}
    )

    it("returns one Sysio phase: bond config, one synd config per pair, then the verifies", () => {
      expect(phase).toBeInstanceOf(ClusterBuildPhase)
      expect(phase.steps.map(step => step.name)).toEqual([
        "configure-bond",
        "configure-syndication-ethereum-liqeth",
        "configure-syndication-solana-liqsol",
        "verify-shadow-precision",
        "verify-liq-token-ethereum-liqeth",
        "verify-liq-token-solana-liqsol"
      ])
      expect(phase.steps.every(step => step.actor === Report.Actor.Sysio)).toBe(
        true
      )
    })

    it("sets sysio.bond's hold bond to the contract default", () => {
      const [bond] = phase.steps
      expect(bond.input).toEqual({
        kind: "BondContractSteps.SetconfigInput",
        data: { hold_bps: Steps.registry.BondHoldBps }
      })
      expect(Steps.registry.BondHoldBps).toBe(1000)
    })

    it("writes each pair's row from SyndicationConfigRegistrations", () => {
      const [, ethereum, solana] = phase.steps
      expect(ethereum.input).toEqual({
        kind: "SyndContractSteps.SetconfigInput",
        data: Steps.registry.SyndicationConfigRegistrations[0]
      })
      expect(solana.input).toEqual({
        kind: "SyndContractSteps.SetconfigInput",
        data: Steps.registry.SyndicationConfigRegistrations[1]
      })
    })

    it("verifies both shadows' precision and both liq tokens' registration", () => {
      const [, , , precision, liqeth, liqsol] = phase.steps
      expect(precision.input).toEqual({
        kind: "WireSyndicationTool.VerifyShadowPrecisionInput",
        symbolCodes: ["LIQETH", "LIQSOL"]
      })
      expect(liqeth.input).toEqual({
        kind: "WireSyndicationTool.VerifyLiqTokenActiveInput",
        chainCode: "ETHEREUM",
        tokenCode: "LIQETH"
      })
      expect(liqsol.input).toEqual({
        kind: "WireSyndicationTool.VerifyLiqTokenActiveInput",
        chainCode: "SOLANA",
        tokenCode: "LIQSOL"
      })
    })
  })
})
