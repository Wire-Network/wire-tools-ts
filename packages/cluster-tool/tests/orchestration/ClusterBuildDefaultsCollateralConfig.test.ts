import Path from "node:path"
import { SlugName } from "@wireio/sdk-core"
import type { CollateralRequirement } from "@wireio/cluster-tool-shared"
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

  /** Compose the real bootstrap with the same requirement for every role. */
  async function compose(requirement: CollateralRequirement) {
    return ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol",
      requiredProducerCollateral: [requirement],
      requiredBatchOperatorCollateral: [requirement],
      requiredUnderwriterCollateral: [requirement]
    })
  }

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
