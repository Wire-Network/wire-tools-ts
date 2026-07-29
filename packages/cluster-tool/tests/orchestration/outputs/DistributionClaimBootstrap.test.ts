import { ChainKind } from "@wireio/opp-typescript-models"
import {
  DistributionClaimBootstrapSource,
  distributionClaimBootstrapCredit,
  finalizeDistributionClaimBootstrap,
  hasDistributionClaimBootstrapChain,
  type DistributionClaimBootstrapCore
} from "@wireio/cluster-tool/orchestration"

describe("DistributionClaimBootstrap", () => {
  const core: DistributionClaimBootstrapCore = {
    creditSets: [
      {
        chain: ChainKind.EVM,
        source: DistributionClaimBootstrapSource.ConfiguredFile,
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

  it("merges additive sources before deterministic batching", () => {
    const result = finalizeDistributionClaimBootstrap(core, {
      creditSets: [
        {
          chain: ChainKind.EVM,
          source: DistributionClaimBootstrapSource.Controlled,
          credits: [
            { native_address: "aa".repeat(20), wire_atomic: 3n },
            { native_address: "cc".repeat(20), wire_atomic: 5n }
          ],
          droppedDust: 0n
        },
        {
          chain: ChainKind.SVM,
          source: DistributionClaimBootstrapSource.Synthetic,
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
        DistributionClaimBootstrapSource.ConfiguredFile,
        DistributionClaimBootstrapSource.Controlled
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
              source: DistributionClaimBootstrapSource.Synthetic,
              credits: [],
              droppedDust: 9n
            }
          ]
        }
      )
    ).toEqual({ chains: [] })
  })
})
