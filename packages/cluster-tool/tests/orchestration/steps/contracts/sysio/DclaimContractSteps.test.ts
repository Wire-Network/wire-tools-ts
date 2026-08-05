import { WireClient } from "@wireio/cluster-tool/clients/wire"
import {
  ClusterBuildContext,
  DistributionClaimBootstrapResultKey,
  OutputStore,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { ChainKind } from "@wireio/opp-typescript-models"

describe("Steps.contracts.sysio.dclaim", () => {
  const finalityError = () =>
    new WireClient.TransactionFinalityError(
      "sysio.dclaim action",
      "transaction-id",
      42,
      { cause: new Error("timed out") }
    )
  const summary = {
    sources: [],
    eligibleAddressCount: 123,
    batchCount: 2,
    totalAtomic: "456",
    droppedDust: "7"
  }

  it("setconfig builds an input-less step with a runner", () => {
    const step = Steps.contracts.sysio.dclaim.planSetconfig(
      Report.Actor.Sysio,
      "init-dclaim",
      "initialize the dclaim cap_config",
      {}
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("importseed validates and carries only compact batch metadata", () => {
    const step = Steps.contracts.sysio.dclaim.planImportSeedBatch(
      Report.Actor.Sysio,
      "import-dclaim-ethereum-1",
      "import one dclaim batch",
      {},
      ChainKind.EVM,
      0,
      123,
      summary
    )
    expect(step.input).toEqual({
      kind: "DclaimContractSteps.ImportSeedBatchInput",
      chain: ChainKind.EVM,
      batchIndex: 0,
      creditCount: 123,
      summary
    })
    expect(step.input).not.toHaveProperty("credits")
    expect(typeof step.runner).toBe("function")
  })

  it("rejects malformed schema-first importseed metadata", () => {
    expect(
      Steps.contracts.sysio.dclaim.ImportSeedChainSummarySchema.safeParse({
        ...summary,
        totalAtomic: "-1"
      }).success
    ).toBe(false)
    expect(
      Steps.contracts.sysio.dclaim.ImportSeedBatchInputSchema.safeParse({
        kind: "DclaimContractSteps.ImportSeedBatchInput",
        chain: ChainKind.EVM,
        batchIndex: -1,
        creditCount: 1,
        summary
      }).success
    ).toBe(false)
    expect(() =>
      Steps.contracts.sysio.dclaim.planImportSeedBatch(
        Report.Actor.Sysio,
        "invalid-import",
        "reject invalid batch metadata",
        {},
        ChainKind.EVM,
        -1,
        1,
        summary
      )
    ).toThrow()
    const invalidChains = [ChainKind.UNKNOWN, ChainKind.WIRE, 999, "2", {}]
    invalidChains.forEach(chain => {
      expect(
        Steps.contracts.sysio.dclaim.ImportSeedBatchInputSchema.safeParse({
          kind: "DclaimContractSteps.ImportSeedBatchInput",
          chain,
          batchIndex: 0,
          creditCount: 1,
          summary
        }).success
      ).toBe(false)
    })
  })

  it("importdone builds one input-less finalization step", () => {
    const step = Steps.contracts.sysio.dclaim.planImportDone(
      Report.Actor.Sysio,
      "finalize-dclaim-import",
      "close the import window",
      {}
    )
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("resolves the bulk batch from outputs and serializes it for importseed", async () => {
    const invokeViaFileOnce = jest.fn().mockResolvedValue(undefined)
    const outputs = new OutputStore().set(DistributionClaimBootstrapResultKey, {
      chains: [
        {
          chain: ChainKind.EVM,
          sources: [],
          batches: [
            {
              chain: ChainKind.EVM,
              credits: [{ native_address: "aa".repeat(20), wire_atomic: 7n }]
            }
          ],
          droppedDust: 0n,
          eligibleAddressCount: 1,
          totalAtomic: 7n
        }
      ]
    })
    const context = {
      outputs,
      wire: {
        getSysioContract: () => ({
          actions: { importseed: { invokeViaFileOnce } },
          tables: {
            capcounters: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ next_unmapped_id: "9" }] })
            }
          }
        })
      }
    } as unknown as ClusterBuildContext
    await Steps.contracts.sysio.dclaim.runImportSeedBatch(
      context,
      {
        kind: "DclaimContractSteps.ImportSeedBatchInput",
        chain: ChainKind.EVM,
        batchIndex: 0,
        creditCount: 1,
        summary: {
          ...summary,
          eligibleAddressCount: 1,
          batchCount: 1,
          totalAtomic: "7",
          droppedDust: "0"
        }
      },
      new AbortController().signal
    )
    expect(invokeViaFileOnce).toHaveBeenCalledWith({
      chain: ChainKind.EVM,
      credits: [{ native_address: "aa".repeat(20), wire_atomic: "7" }]
    })
  })

  it("rejects when compact metadata no longer matches the stored batch", async () => {
    const outputs = new OutputStore().set(DistributionClaimBootstrapResultKey, {
      chains: [
        {
          chain: ChainKind.EVM,
          sources: [],
          batches: [{ chain: ChainKind.EVM, credits: [] }],
          droppedDust: 0n,
          eligibleAddressCount: 0,
          totalAtomic: 0n
        }
      ]
    })
    const context = {
      outputs,
      wire: {}
    } as unknown as ClusterBuildContext
    await expect(
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        {
          kind: "DclaimContractSteps.ImportSeedBatchInput",
          chain: ChainKind.EVM,
          batchIndex: 0,
          creditCount: 1,
          summary: {
            ...summary,
            eligibleAddressCount: 1,
            batchCount: 1,
            totalAtomic: "1",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/batch size changed/)
  })

  it("invokes importdone with an empty payload", async () => {
    const invokeOnce = jest.fn().mockResolvedValue(undefined)
    const context = {
      wire: {
        getSysioContract: () => ({
          actions: { importdone: { invokeOnce } }
        })
      }
    } as unknown as ClusterBuildContext
    await Steps.contracts.sysio.dclaim.runImportDone(
      context,
      null,
      new AbortController().signal
    )
    expect(invokeOnce).toHaveBeenCalledWith({})
  })

  it("reconciles an accepted importseed after finality observation is lost without resending", async () => {
    const firstAddress = "bb".repeat(20),
      secondAddress = "bc".repeat(20),
      invokeViaFileOnce = jest.fn().mockRejectedValue(finalityError()),
      isTransactionIrreversible = jest.fn().mockResolvedValue(true),
      unmappedQuery = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "17",
              chain_kind: ChainKind.EVM,
              native_pubkey: firstAddress,
              balance: "0.000000009 WIRE",
              expires_at_sec: 1
            }
          ],
          more: true,
          nextKey: "18"
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "18",
              chain_kind: ChainKind.EVM,
              native_pubkey: secondAddress,
              balance: "0.000000010 WIRE",
              expires_at_sec: 1
            }
          ],
          more: false,
          nextKey: null
        }),
      context = {
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [
                    { native_address: firstAddress, wire_atomic: 9n },
                    { native_address: secondAddress, wire_atomic: 10n }
                  ]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 2,
              totalAtomic: 19n
            }
          ]
        }),
        wire: {
          isTransactionIrreversible,
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "17" }] })
              },
              unmapped: {
                query: unmappedQuery
              }
            }
          })
        }
      } as unknown as ClusterBuildContext

    await expect(
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        {
          kind: "DclaimContractSteps.ImportSeedBatchInput",
          chain: ChainKind.EVM,
          batchIndex: 0,
          creditCount: 2,
          summary: {
            ...summary,
            eligibleAddressCount: 2,
            batchCount: 1,
            totalAtomic: "19",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
    expect(isTransactionIrreversible).toHaveBeenCalledWith("transaction-id", 42)
    expect(unmappedQuery).toHaveBeenNthCalledWith(1, {
      lowerBound: "17",
      upperBound: "19",
      limit: 2
    })
    expect(unmappedQuery).toHaveBeenNthCalledWith(2, {
      lowerBound: "18",
      upperBound: "19",
      limit: 1
    })
  })

  it("does not accept matching importseed state before the transaction is irreversible", async () => {
    const address = "cc".repeat(20),
      invokeViaFileOnce = jest.fn().mockRejectedValue(finalityError()),
      context = {
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 11n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 11n
            }
          ]
        }),
        wire: {
          isTransactionIrreversible: jest.fn().mockResolvedValue(false),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "23" }] })
              },
              unmapped: { query: jest.fn() }
            }
          })
        }
      } as unknown as ClusterBuildContext

    await expect(
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        {
          kind: "DclaimContractSteps.ImportSeedBatchInput",
          chain: ChainKind.EVM,
          batchIndex: 0,
          creditCount: 1,
          summary: {
            ...summary,
            eligibleAddressCount: 1,
            batchCount: 1,
            totalAtomic: "11",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(WireClient.TransactionFinalityError)
    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
  })

  it("reconciles an irreversible importdone action from capcfg without resending", async () => {
    const invokeOnce = jest.fn().mockRejectedValue(finalityError()),
      isTransactionIrreversible = jest.fn().mockResolvedValue(true),
      context = {
        wire: {
          isTransactionIrreversible,
          getSysioContract: () => ({
            actions: { importdone: { invokeOnce } },
            tables: {
              capcfg: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ imported_complete: 1 }] })
              }
            }
          })
        }
      } as unknown as ClusterBuildContext

    await expect(
      Steps.contracts.sysio.dclaim.runImportDone(
        context,
        null,
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(invokeOnce).toHaveBeenCalledTimes(1)
    expect(isTransactionIrreversible).toHaveBeenCalledWith("transaction-id", 42)
  })
})
