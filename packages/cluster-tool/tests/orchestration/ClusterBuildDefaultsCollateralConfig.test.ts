import Path from "node:path"
import { SlugName } from "@wireio/sdk-core"
import type { CollateralRequirement } from "@wireio/cluster-tool-shared"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

const ChainCode = "ETHEREUM"
const TokenCode = "ETH"
const MinimumBond = 125
/** Slugs occupy 48 bits; this bit must never disappear during conversion. */
const OutsideSlugBits = 2 ** 48

describe("ClusterBuildDefaults — collateral ABI codes", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("collateral-config-")
  })

  afterEach(() => {
    jest.restoreAllMocks()
    environment.cleanup()
  })

  /** Compose the real bootstrap over `options`. */
  async function composeBootstrap(options: ClusterBuildOptions = {}) {
    return ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol",
      ...options
    })
  }

  /** Compose the real bootstrap with the same requirement for every role. */
  async function compose(requirement: CollateralRequirement) {
    return composeBootstrap({
      requiredProducerCollateral: [requirement],
      requiredBatchOperatorCollateral: [requirement],
      requiredUnderwriterCollateral: [requirement]
    })
  }

  it("defaults the producer minimum to the launch bond: 0.2 LIQETH and 5 LIQSOL on WIRE", async () => {
    const plan = jest.spyOn(Steps.contracts.sysio.opreg, "planSetconfig")
    await composeBootstrap()
    const data = plan.mock.calls[0][4]
    expect(data.req_prod_collat).toEqual([
      {
        chain_code: "WIRE",
        token_code: "LIQETH",
        min_bond: 200_000_000,
        config_timestamp_ms: 0
      },
      {
        chain_code: "WIRE",
        token_code: "LIQSOL",
        min_bond: 5_000_000_000,
        config_timestamp_ms: 0
      }
    ])
    expect(data.req_batchop_collat).toEqual([])
    expect(data.req_uw_collat).toEqual([])
  })

  it("lets an explicit producer requirement, even an empty one, replace the launch minimum", async () => {
    const plan = jest.spyOn(Steps.contracts.sysio.opreg, "planSetconfig")
    await composeBootstrap({ requiredProducerCollateral: [] })
    expect(plan.mock.calls[0][4].req_prod_collat).toEqual([])
  })

  it("writes canonical strings and preserves collateral amounts for all roles", async () => {
    const plan = jest.spyOn(Steps.contracts.sysio.opreg, "planSetconfig")
    await compose({
      chainCode: SlugName.from(ChainCode),
      tokenCode: SlugName.from(TokenCode),
      minimumBond: MinimumBond
    })
    expect(plan).toHaveBeenCalledTimes(1)
    const data = plan.mock.calls[0][4]
    const expected = [{
      chain_code: ChainCode,
      token_code: TokenCode,
      min_bond: MinimumBond,
      config_timestamp_ms: 0
    }]
    expect(data.req_prod_collat).toEqual(expected)
    expect(data.req_batchop_collat).toEqual(expected)
    expect(data.req_uw_collat).toEqual(expected)
  })

  it.each(["chainCode", "tokenCode"] as const)(
    "rejects high bits in %s instead of silently selecting another asset",
    async field => {
      const requirement = {
        chainCode: SlugName.from(ChainCode),
        tokenCode: SlugName.from(TokenCode),
        minimumBond: MinimumBond
      }
      requirement[field] += OutsideSlugBits
      await expect(compose(requirement)).rejects.toThrow(/canonical packed slug_name/)
    }
  )

  it.each([1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed packed code %s rather than emitting an empty or altered code",
    async chainCode => {
      await expect(compose({
        chainCode,
        tokenCode: SlugName.from(TokenCode),
        minimumBond: MinimumBond
      })).rejects.toThrow()
    }
  )
})
