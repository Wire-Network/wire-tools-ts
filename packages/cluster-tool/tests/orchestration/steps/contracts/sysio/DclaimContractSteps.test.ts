import { ChainKind } from "@wireio/opp-typescript-models"
import {
  ClusterBuildContext,
  DistributionClaimBootstrapResultKey,
  OutputStore,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Report } from "@wireio/cluster-tool/report"

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

  it("importseed carries only compact batch metadata in its Step input", () => {
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
    const invokeViaFile = jest.fn().mockResolvedValue(undefined)
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
          actions: { importseed: { invokeViaFile } },
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
    expect(invokeViaFile).toHaveBeenCalledWith(
      {
        chain: ChainKind.EVM,
        credits: [{ native_address: "aa".repeat(20), wire_atomic: "7" }]
      },
      { retryFinality: false, retryTransport: false }
    )
  })

  it("invokes importdone with an empty payload", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined)
    const context = {
      wire: {
        getSysioContract: () => ({
          actions: { importdone: { invoke } },
          tables: { capcfg: { query: jest.fn() } }
        })
      }
    } as unknown as ClusterBuildContext
    await Steps.contracts.sysio.dclaim.runImportDone(
      context,
      null,
      new AbortController().signal
    )
    expect(invoke).toHaveBeenCalledWith(
      {},
      { retryFinality: false, retryTransport: false }
    )
  })

  it("reconciles an importseed finality error without resending", async () => {
    const address = "bb".repeat(20)
    const invokeViaFile = jest.fn().mockRejectedValue(finalityError())
    const isTransactionIrreversible = jest.fn().mockResolvedValue(true)
    const context = {
      outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
        chains: [
          {
            chain: ChainKind.EVM,
            sources: [],
            batches: [
              {
                chain: ChainKind.EVM,
                credits: [{ native_address: address, wire_atomic: 9n }]
              }
            ],
            droppedDust: 0n,
            eligibleAddressCount: 1,
            totalAtomic: 9n
          }
        ]
      }),
      wire: {
        isTransactionIrreversible,
        getSysioContract: () => ({
          actions: { importseed: { invokeViaFile } },
          tables: {
            capcounters: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ next_unmapped_id: "17" }] })
            },
            unmapped: {
              query: jest.fn().mockResolvedValue({
                rows: [
                  {
                    id: "17",
                    chain_kind: ChainKind.EVM,
                    native_pubkey: address,
                    balance: "0.000000009 WIRE",
                    expires_at_sec: 1
                  }
                ]
              })
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
          creditCount: 1,
          summary: {
            ...summary,
            eligibleAddressCount: 1,
            batchCount: 1,
            totalAtomic: "9",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(invokeViaFile).toHaveBeenCalledTimes(1)
    expect(isTransactionIrreversible).toHaveBeenCalledWith("transaction-id", 42)
  })

  it("reconciles an importdone finality error from capcfg", async () => {
    const invoke = jest.fn().mockRejectedValue(finalityError())
    const isTransactionIrreversible = jest.fn().mockResolvedValue(true)
    const context = {
      wire: {
        isTransactionIrreversible,
        getSysioContract: () => ({
          actions: { importdone: { invoke } },
          tables: {
            capcfg: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ imported_complete: true }] })
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
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(isTransactionIrreversible).toHaveBeenCalledWith("transaction-id", 42)
  })

  it("rejects a matching speculative importseed state", async () => {
    const address = "cc".repeat(20)
    const invokeViaFile = jest.fn().mockRejectedValue(finalityError())
    const context = {
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
          actions: { importseed: { invokeViaFile } },
          tables: {
            capcounters: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ next_unmapped_id: "23" }] })
            },
            unmapped: {
              query: jest.fn().mockResolvedValue({
                rows: [
                  {
                    id: "23",
                    chain_kind: ChainKind.EVM,
                    native_pubkey: address,
                    balance: "0.000000011 WIRE",
                    expires_at_sec: 1
                  }
                ]
              })
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
    expect(invokeViaFile).toHaveBeenCalledTimes(1)
  })

  it("logs a failed importseed reconciliation query", async () => {
    const warn = jest.fn()
    const address = "dd".repeat(20)
    const context = {
      log: { warn },
      outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
        chains: [
          {
            chain: ChainKind.EVM,
            sources: [],
            batches: [
              {
                chain: ChainKind.EVM,
                credits: [{ native_address: address, wire_atomic: 13n }]
              }
            ],
            droppedDust: 0n,
            eligibleAddressCount: 1,
            totalAtomic: 13n
          }
        ]
      }),
      wire: {
        isTransactionIrreversible: jest.fn().mockResolvedValue(true),
        getSysioContract: () => ({
          actions: {
            importseed: {
              invokeViaFile: jest.fn().mockRejectedValue(finalityError())
            }
          },
          tables: {
            capcounters: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ next_unmapped_id: "31" }] })
            },
            unmapped: {
              query: jest.fn().mockRejectedValue(new Error("RPC unavailable"))
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
          creditCount: 1,
          summary: {
            ...summary,
            eligibleAddressCount: 1,
            batchCount: 1,
            totalAtomic: "13",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(WireClient.TransactionFinalityError)
    expect(warn).toHaveBeenCalledWith(
      "dclaim importseed reconciliation query failed: RPC unavailable"
    )
  })

  it("rejects a matching speculative importdone state", async () => {
    const invoke = jest.fn().mockRejectedValue(finalityError())
    const context = {
      wire: {
        isTransactionIrreversible: jest.fn().mockResolvedValue(false),
        getSysioContract: () => ({
          actions: { importdone: { invoke } },
          tables: {
            capcfg: {
              query: jest
                .fn()
                .mockResolvedValue({ rows: [{ imported_complete: true }] })
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
    ).rejects.toBeInstanceOf(WireClient.TransactionFinalityError)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
