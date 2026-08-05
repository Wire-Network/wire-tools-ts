import {
  DistributionClaimBootstrapChainResultSchema,
  DistributionClaimBootstrapContributionSchema,
  DistributionClaimBootstrapCoreSchema,
  DistributionClaimBootstrapCreditSetSchema,
  DistributionClaimBootstrapResultSchema,
  DistributionClaimBootstrapSource,
  DistributionClaimBootstrapSourceSchema,
  distributionClaimBootstrapCredit,
  finalizeDistributionClaimBootstrap,
  hasDistributionClaimBootstrapChain,
  type DistributionClaimBootstrapCore
} from "@wireio/cluster-tool/orchestration"
import { ChainKind } from "@wireio/opp-typescript-models"

describe("DistributionClaimBootstrap", () => {
  const core: DistributionClaimBootstrapCore = {
    creditSets: [
      {
        chain: ChainKind.EVM,
        source: DistributionClaimBootstrapSource.configuredFile,
        credits: [
          { native_address: "bb".repeat(20), wire_atomic: 4n },
          { native_address: "aa".repeat(20), wire_atomic: 2n }
        ],
        droppedDust: 7n
      }
    ]
  }

  it("detects only configured-file chains", () => {
    expect(hasDistributionClaimBootstrapChain(core, ChainKind.EVM)).toBe(true)
    expect(hasDistributionClaimBootstrapChain(core, ChainKind.SVM)).toBe(false)
  })

  it("validates every schema-first bootstrap output layer", () => {
    const creditSet = core.creditSets[0],
      result = finalizeDistributionClaimBootstrap(core)
    expect(
      DistributionClaimBootstrapSourceSchema.safeParse(creditSet.source).success
    ).toBe(true)
    expect(
      DistributionClaimBootstrapCreditSetSchema.safeParse(creditSet).success
    ).toBe(true)
    expect(DistributionClaimBootstrapCoreSchema.safeParse(core).success).toBe(
      true
    )
    expect(
      DistributionClaimBootstrapContributionSchema.safeParse({
        creditSets: [creditSet]
      }).success
    ).toBe(true)
    expect(
      DistributionClaimBootstrapChainResultSchema.safeParse(result.chains[0])
        .success
    ).toBe(true)
    expect(
      DistributionClaimBootstrapResultSchema.safeParse(result).success
    ).toBe(true)
    expect(
      DistributionClaimBootstrapCreditSetSchema.safeParse({
        ...creditSet,
        droppedDust: -1n
      }).success
    ).toBe(false)
    const invalidChains = [ChainKind.UNKNOWN, ChainKind.WIRE, 999, "2", {}]
    invalidChains.forEach(chain => {
      expect(
        DistributionClaimBootstrapCreditSetSchema.safeParse({
          ...creditSet,
          chain
        }).success
      ).toBe(false)
      expect(
        DistributionClaimBootstrapChainResultSchema.safeParse({
          ...result.chains[0],
          chain
        }).success
      ).toBe(false)
    })
    expect(DistributionClaimBootstrapSource.configuredFile).toBe(
      "configuredFile"
    )
  })

  it("merges additive sources before deterministic batching", () => {
    const result = finalizeDistributionClaimBootstrap(core, {
      creditSets: [
        {
          chain: ChainKind.EVM,
          source: DistributionClaimBootstrapSource.controlled,
          credits: [
            { native_address: "aa".repeat(20), wire_atomic: 3n },
            { native_address: "cc".repeat(20), wire_atomic: 5n }
          ],
          droppedDust: 0n
        },
        {
          chain: ChainKind.SVM,
          source: DistributionClaimBootstrapSource.synthetic,
          credits: [{ native_address: "dd".repeat(32), wire_atomic: 11n }],
          droppedDust: 0n
        }
      ]
    })
    expect(result.chains.map(chain => chain.chain)).toEqual([
      ChainKind.EVM,
      ChainKind.SVM
    ])
    expect(result.chains[0].batches[0].credits).toEqual([
      { native_address: "aa".repeat(20), wire_atomic: 5n },
      { native_address: "bb".repeat(20), wire_atomic: 4n },
      { native_address: "cc".repeat(20), wire_atomic: 5n }
    ])
    expect(result.chains[0]).toMatchObject({
      eligibleAddressCount: 3,
      totalAtomic: 14n,
      droppedDust: 7n,
      sources: [
        DistributionClaimBootstrapSource.configuredFile,
        DistributionClaimBootstrapSource.controlled
      ]
    })
    expect(
      distributionClaimBootstrapCredit(result, ChainKind.EVM, "aa".repeat(20))
    ).toBe(5n)
    expect(
      distributionClaimBootstrapCredit(result, ChainKind.SVM, "ff".repeat(32))
    ).toBe(0n)
  })

  it("keeps an ordinary no-input bootstrap empty", () => {
    expect(finalizeDistributionClaimBootstrap({ creditSets: [] })).toEqual({
      chains: []
    })
  })

  it("does not finalize a scenario contribution with no eligible credits", () => {
    expect(
      finalizeDistributionClaimBootstrap(
        { creditSets: [] },
        {
          creditSets: [
            {
              chain: ChainKind.EVM,
              source: DistributionClaimBootstrapSource.synthetic,
              credits: [],
              droppedDust: 9n
            }
          ]
        }
      )
    ).toEqual({ chains: [] })
  })
})
