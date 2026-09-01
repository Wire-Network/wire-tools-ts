import {
  DistributionClaimBootstrapBatchSchema,
  DistributionClaimBootstrapCreditSetSchema,
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapResultSchema,
  DistributionClaimBootstrapSource,
  createDistributionClaimBootstrapPlan,
  distributionClaimBootstrapCredit,
  type DistributionClaimBootstrapCreditSet,
  type DistributionClaimBootstrapInputCreditSet
} from "@wireio/cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"

describe("DistributionClaimBootstrapOutput", () => {
  it("selects configured data per chain and merges additive credits before batching", () => {
    const result = createDistributionClaimBootstrapPlan({
      configuredCreditSets: [
        {
          chain: ChainKind.EVM,
          credits: [
            { native_address: "aa".repeat(20), wire_atomic: 2n },
            { native_address: "bb".repeat(20), wire_atomic: 4n }
          ],
          droppedDust: 7n
        }
      ],
      fallbackCreditSets: [
        {
          chain: ChainKind.EVM,
          credits: [{ native_address: "ff".repeat(20), wire_atomic: 99n }],
          droppedDust: 1n
        },
        {
          chain: ChainKind.SVM,
          credits: [{ native_address: "dd".repeat(32), wire_atomic: 11n }],
          droppedDust: 0n
        }
      ],
      additiveCreditSets: [
        {
          chain: ChainKind.EVM,
          credits: [
            { native_address: "aa".repeat(20), wire_atomic: 3n },
            { native_address: "cc".repeat(20), wire_atomic: 5n }
          ],
          droppedDust: 0n
        },
        {
          chain: ChainKind.EVM,
          credits: [],
          droppedDust: 13n
        },
        {
          chain: ChainKind.SVM,
          credits: [],
          droppedDust: 17n
        }
      ],
      batchSize: 2
    })

    expect(result.chains.map(chain => chain.chain)).toEqual([
      ChainKind.EVM,
      ChainKind.SVM
    ])
    expect(result.chains[0].batches.flatMap(batch => batch.credits)).toEqual([
      { native_address: "aa".repeat(20), wire_atomic: 5n },
      { native_address: "bb".repeat(20), wire_atomic: 4n },
      { native_address: "cc".repeat(20), wire_atomic: 5n }
    ])
    expect(result.chains[0]).toMatchObject({
      eligibleAddressCount: 3,
      totalAtomic: 14n,
      droppedDust: 20n,
      sources: [
        DistributionClaimBootstrapSource.configuredFile,
        DistributionClaimBootstrapSource.additive
      ]
    })
    expect(result.chains[1]).toMatchObject({
      sources: [DistributionClaimBootstrapSource.fallback],
      droppedDust: 17n
    })
  })

  it("assigns stable batch indexes and globally consecutive first row ids", () => {
    const result = createDistributionClaimBootstrapPlan({
      fallbackCreditSets: [
        {
          chain: ChainKind.EVM,
          credits: [
            { native_address: "11".repeat(20), wire_atomic: 1n },
            { native_address: "22".repeat(20), wire_atomic: 1n },
            { native_address: "33".repeat(20), wire_atomic: 1n }
          ],
          droppedDust: 0n
        },
        {
          chain: ChainKind.SVM,
          credits: [{ native_address: "44".repeat(32), wire_atomic: 1n }],
          droppedDust: 0n
        }
      ],
      batchSize: 2,
      firstUnmappedId: 41n
    })
    expect(
      result.chains.flatMap(chain =>
        chain.batches.map(batch => ({
          chain: batch.chain,
          batchIndex: batch.batchIndex,
          firstUnmappedId: batch.firstUnmappedId,
          creditCount: batch.credits.length
        }))
      )
    ).toEqual([
      {
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: 41n,
        creditCount: 2
      },
      {
        chain: ChainKind.EVM,
        batchIndex: 1,
        firstUnmappedId: 43n,
        creditCount: 1
      },
      {
        chain: ChainKind.SVM,
        batchIndex: 0,
        firstUnmappedId: 44n,
        creditCount: 1
      }
    ])
    result.chains
      .flatMap(chain => chain.batches)
      .forEach(batch =>
        expect(
          DistributionClaimBootstrapBatchSchema.safeParse(batch).success
        ).toBe(true)
      )
    expect(
      createDistributionClaimBootstrapPlan({
        fallbackCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [{ native_address: "55".repeat(20), wire_atomic: 1n }],
            droppedDust: 0n
          }
        ]
      }).chains[0].batches[0].firstUnmappedId
    ).toBe(1n)

    const maxUnmappedId = (1n << 64n) - 1n,
      boundaryCreditSet: DistributionClaimBootstrapInputCreditSet = {
        chain: ChainKind.EVM,
        credits: [{ native_address: "66".repeat(20), wire_atomic: 1n }],
        droppedDust: 0n
      }
    expect(
      createDistributionClaimBootstrapPlan({
        fallbackCreditSets: [boundaryCreditSet],
        firstUnmappedId: maxUnmappedId
      }).chains[0].batches[0].firstUnmappedId
    ).toBe(maxUnmappedId)
    expect(() =>
      createDistributionClaimBootstrapPlan({
        fallbackCreditSets: [
          {
            ...boundaryCreditSet,
            credits: [
              ...boundaryCreditSet.credits,
              { native_address: "77".repeat(20), wire_atomic: 1n }
            ]
          }
        ],
        firstUnmappedId: maxUnmappedId
      })
    ).toThrow(/uint64/)
    expect(() =>
      createDistributionClaimBootstrapPlan({
        firstUnmappedId: maxUnmappedId + 1n
      })
    ).toThrow(/uint64/)
  })

  it("provides runtime schemas and final credit lookup", () => {
    const configuredCreditSet: DistributionClaimBootstrapCreditSet = {
        chain: ChainKind.EVM,
        source: DistributionClaimBootstrapSource.configuredFile,
        credits: [{ native_address: "aa".repeat(20), wire_atomic: 2n }],
        droppedDust: 0n
      },
      result = createDistributionClaimBootstrapPlan({
        configuredCreditSets: [configuredCreditSet]
      })
    expect(
      DistributionClaimBootstrapCreditSetSchema.safeParse(configuredCreditSet)
        .success
    ).toBe(true)
    expect(
      DistributionClaimBootstrapCreditSetSchema.safeParse({
        ...configuredCreditSet,
        credits: [{ native_address: "aa".repeat(32), wire_atomic: 2n }]
      }).success
    ).toBe(false)
    expect(
      DistributionClaimBootstrapResultSchema.safeParse(result).success
    ).toBe(true)
    expect(DistributionClaimBootstrapResultKey).toEqual({
      name: "cluster.distributionClaimBootstrapResult",
      description: "the finalized distribution-claim bootstrap plan"
    })
    expect(
      distributionClaimBootstrapCredit(result, ChainKind.EVM, "aa".repeat(20))
    ).toBe(2n)
    expect(
      distributionClaimBootstrapCredit(result, ChainKind.SVM, "aa".repeat(32))
    ).toBe(0n)
  })

  it("keeps absent and empty fallback inputs dormant but rejects empty configured data", () => {
    expect(createDistributionClaimBootstrapPlan()).toEqual({ chains: [] })
    expect(
      createDistributionClaimBootstrapPlan({
        fallbackCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [],
            droppedDust: 9n
          }
        ]
      })
    ).toEqual({ chains: [] })
    expect(() =>
      createDistributionClaimBootstrapPlan({
        configuredCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [{ native_address: "99".repeat(20), wire_atomic: 1n }],
            droppedDust: 0n
          },
          {
            chain: ChainKind.EVM,
            credits: [],
            droppedDust: 9n
          }
        ],
        fallbackCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [{ native_address: "88".repeat(20), wire_atomic: 1n }],
            droppedDust: 0n
          }
        ]
      })
    ).toThrow(/configured.*no eligible credits.*Ethereum/)
    expect(() =>
      createDistributionClaimBootstrapPlan({ firstUnmappedId: 0n })
    ).toThrow()
  })
})
