import { ClusterBuild, ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { getLogger } from "@wireio/cluster-tool/logging"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const RegistrySteps = Steps.registry

describe("RegistrySteps liq pool registration", () => {
  let context: ClusterBuildContext
  beforeEach(() => {
    context = new ClusterBuildContext(fixtureConfig(), getLogger("liq-pool-filter-test"))
  })

  it("builds a pool row with the dev parameters and the caller's shadow seed", () => {
    const row = RegistrySteps.liqPoolRegistration(
      RegistrySteps.EthereumChainCodename,
      RegistrySteps.EthereumLiqTokenCodename,
      "37940000000"
    )
    expect(row.chain_code).toBe("ETHEREUM")
    expect(row.token_code).toBe("LIQETH")
    expect(row.initial_chain_amount).toBe("37940000000")
    expect(row.pair_symbol).toBe("9,LIQETHP")
    // every other parameter is the mock pools' own
    const mock = RegistrySteps.MockLiqPoolRegistrations[0]
    expect({ ...row, initial_chain_amount: mock.initial_chain_amount }).toEqual(mock)
  })

  it("seeds both mock pools by default, and only the named chains when filtered", () => {
    const build = ClusterBuild.forContext(context),
      all = RegistrySteps.planMockLiqPools(build, "all", "all", {}),
      solana = RegistrySteps.planMockLiqPools(build, "solana", "solana", {}, [RegistrySteps.SolanaChainCodename])
    expect(all.steps.map(step => step.name)).toEqual([
      "seed-liq-pool-ethereum-liqeth",
      "seed-liq-pool-solana-liqsol"
    ])
    expect(solana.steps.map(step => step.name)).toEqual(["seed-liq-pool-solana-liqsol"])
  })
})
