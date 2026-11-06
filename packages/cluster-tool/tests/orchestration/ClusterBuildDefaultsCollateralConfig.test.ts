import Path from "node:path"

import { SlugName } from "@wireio/sdk-core"

import type { CollateralRequirement } from "@wireio/cluster-tool-shared"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import { Constants } from "@wireio/cluster-tool"

import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectStepNames } from "./clusterBuildFixture.js"

const ChainCode = "ETHEREUM"
const TokenCode = "ETH"
const MinimumBond = 125
/** Slugs occupy 48 bits; this bit must never disappear during conversion. */
const OutsideSlugBits = 2 ** 48
/** Launch producer minima from Tools PR176, in nine-decimal atomic units. */
const LaunchProducerCollateral: CollateralRequirement[] = [
  {
    chainCode: Constants.WireChainCode,
    tokenCode: SlugName.from(Constants.liqTokenCode(Constants.ETHEREUM_CHAIN_CODENAME)),
    minimumBond: 200_000_000
  },
  {
    chainCode: Constants.WireChainCode,
    tokenCode: SlugName.from(Constants.LIQSOL_CODENAME),
    minimumBond: 5_000_000_000
  }
]

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

  it.each([
    { requiredProducerCollateral: LaunchProducerCollateral },
    { requiredProducerCollateral: [] }
  ])(
    "configures launch producer collateral or an explicit empty override after registry seeding: %j",
    async ({ requiredProducerCollateral }) => {
      const plan = jest.spyOn(Steps.contracts.sysio.opreg, "planSetconfig"),
        bindings = jest.spyOn(Steps.contracts.sysio.tokens, "planRegctok"),
        cluster = await ClusterBuildDefaults.create({
          clusterPath: Path.join(environment.rootPath, "cluster"),
          buildPath: environment.buildPath,
          ethereumPath: "/fake/eth",
          solanaPath: "/fake/sol",
          requiredProducerCollateral
        }),
        steps = collectStepNames(cluster.children)

      expect(steps.indexOf("seed-registry")).toBeGreaterThanOrEqual(0)
      expect(steps.indexOf("configure-opreg")).toBeGreaterThan(steps.indexOf("seed-registry"))
      expect(bindings).toHaveBeenCalledTimes(Constants.SHADOW_LIQ_TOKEN_PAIRS.length)
      Constants.SHADOW_LIQ_TOKEN_PAIRS.forEach(([, tokenCodename], index) => {
        const binding = bindings.mock.calls[index],
          stepIndex = steps.indexOf(binding[1])
        expect(stepIndex).toBeGreaterThan(steps.indexOf("seed-registry"))
        expect(stepIndex).toBeLessThan(steps.indexOf("configure-opreg"))
        expect(binding[4]).toEqual({
          chain_code: SlugName.toString(Constants.WireChainCode),
          token_code: tokenCodename,
          contract_addr: "",
          is_native: false
        })
      })
      const producers = steps.filter(name => name.startsWith("regoperator-defproducer"))
      expect(producers.length).toBeGreaterThan(0)
      producers.forEach(name => {
        expect(steps.indexOf(name)).toBeLessThan(steps.indexOf("seed-registry"))
      })
      expect(plan).toHaveBeenCalledTimes(1)
      expect(plan.mock.calls[0][4].req_prod_collat).toEqual(
        requiredProducerCollateral.map(({ chainCode, tokenCode, minimumBond }) => ({
          chain_code: SlugName.toString(chainCode),
          token_code: SlugName.toString(tokenCode),
          min_bond: minimumBond,
          config_timestamp_ms: 0
        }))
      )
    }
  )

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
