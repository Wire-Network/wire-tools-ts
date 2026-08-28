import Crypto from "node:crypto"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

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
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "dclaim-steps-"))
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

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
  const payloadSha256 = (
    chain: ChainKind,
    credits: { native_address: string; wire_atomic: string }[]
  ) =>
    Crypto.createHash("sha256")
      .update(JSON.stringify({ chain, credits }))
      .digest("hex")

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
      "1",
      123,
      summary
    )
    expect(step.input).toEqual({
      kind: "DclaimContractSteps.ImportSeedBatchInput",
      chain: ChainKind.EVM,
      batchIndex: 0,
      firstUnmappedId: "1",
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
        firstUnmappedId: "1",
        creditCount: 1,
        summary
      }).success
    ).toBe(false)
    expect(
      Steps.contracts.sysio.dclaim.ImportSeedBatchInputSchema.safeParse({
        kind: "DclaimContractSteps.ImportSeedBatchInput",
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: "01",
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
        "1",
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
          firstUnmappedId: "1",
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
      config: { dataPath },
      outputs,
      wire: {
        getInfo: jest.fn().mockResolvedValue({
          head_block_time: "2026-08-27T00:00:00.000"
        }),
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
        firstUnmappedId: "9",
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

  it("allows only one concurrent submission for the same batch", async () => {
    const address = "af".repeat(20),
      invokeViaFileOnce = jest
        .fn()
        .mockImplementation(
          async () => new Promise(resolve => setTimeout(resolve, 10))
        ),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
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
      } as unknown as ClusterBuildContext,
      input = {
        kind: "DclaimContractSteps.ImportSeedBatchInput" as const,
        chain: ChainKind.EVM as const,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        summary: {
          ...summary,
          eligibleAddressCount: 1,
          batchCount: 1,
          totalAtomic: "7",
          droppedDust: "0"
        }
      }

    const results = await Promise.allSettled([
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        input,
        new AbortController().signal
      ),
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        input,
        new AbortController().signal
      )
    ])

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1)
    const rejected = results.find(result => result.status === "rejected")
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "EEXIST" })
    })
    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
  })

  it("does not resubmit a deterministic batch that landed before restart", async () => {
    const address = "ab".repeat(20)
    let landed = false
    const invokeViaFileOnce = jest.fn().mockImplementation(async () => {
        landed = true
      }),
      capcountersQuery = jest.fn().mockImplementation(async () => ({
        rows: [{ next_unmapped_id: landed ? "10" : "9" }]
      })),
      unmappedQuery = jest.fn().mockImplementation(async () => ({
        rows: landed
          ? [
              {
                id: "9",
                chain_kind: ChainKind.EVM,
                native_pubkey: address,
                balance: "0.000000007 WIRE",
                expires_at_sec: 1
              }
            ]
          : [],
        more: false,
        nextKey: null
      })),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
        wire: {
          getInfo: jest
            .fn()
            .mockResolvedValue({
              head_block_time: "2026-08-27T00:00:00.000",
              head_block_num: 91,
              head_block_id: "block-91"
            }),
          waitForBlockIrreversible: jest.fn().mockResolvedValue(true),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: { query: capcountersQuery },
              unmapped: { query: unmappedQuery }
            }
          })
        }
      } as unknown as ClusterBuildContext,
      input = {
        kind: "DclaimContractSteps.ImportSeedBatchInput" as const,
        chain: ChainKind.EVM as const,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        summary: {
          ...summary,
          eligibleAddressCount: 1,
          batchCount: 1,
          totalAtomic: "7",
          droppedDust: "0"
        }
      }

    await Steps.contracts.sysio.dclaim.runImportSeedBatch(
      context,
      input,
      new AbortController().signal
    )
    await Steps.contracts.sysio.dclaim.runImportSeedBatch(
      context,
      input,
      new AbortController().signal
    )

    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
    expect(unmappedQuery).toHaveBeenCalledTimes(2)
  })

  it("waits for a pending pre-crash submission to land instead of resubmitting", async () => {
    const address = "ac".repeat(20),
      journalPath = Path.join(
        dataPath,
        `.dclaim-importseed-${ChainKind.EVM}-0-9.pending.json`
      )
    Fs.writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "DclaimContractSteps.PendingImportSeed",
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        payloadSha256: payloadSha256(ChainKind.EVM, [
          { native_address: address, wire_atomic: "7" }
        ]),
        expiresAfterChainTimeMs: Date.parse("2026-08-27T00:03:00.000Z")
      })
    )

    let landed = false
    const invokeViaFileOnce = jest.fn(),
      unmappedQuery = jest.fn().mockImplementation(async () => ({
        rows: landed
          ? [
              {
                id: "9",
                chain_kind: ChainKind.EVM,
                native_pubkey: address,
                balance: "0.000000007 WIRE",
                expires_at_sec: 1
              }
            ]
          : [],
        more: false,
        nextKey: null
      })),
      waitForHeadToAdvance = jest.fn().mockImplementation(async () => {
        landed = true
      }),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
        wire: {
          getInfo: jest
            .fn()
            .mockResolvedValueOnce({
              head_block_time: "2026-08-27T00:00:00.000"
            })
            .mockResolvedValue({
              head_block_time: "2026-08-27T00:00:01.000",
              head_block_num: 92,
              head_block_id: "block-92"
            }),
          waitForHeadToAdvance,
          waitForBlockIrreversible: jest.fn().mockResolvedValue(true),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "9" }] })
              },
              unmapped: { query: unmappedQuery }
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
        firstUnmappedId: "9",
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

    expect(invokeViaFileOnce).not.toHaveBeenCalled()
    expect(waitForHeadToAdvance).toHaveBeenCalledTimes(1)
    expect(unmappedQuery).toHaveBeenCalledTimes(3)
    expect(Fs.existsSync(journalPath)).toBe(false)
  })

  it("keeps an unbounded crash marker instead of resubmitting", async () => {
    const address = "ag".repeat(20),
      journalPath = Path.join(
        dataPath,
        `.dclaim-importseed-${ChainKind.EVM}-0-9.pending.json`
      )
    Fs.writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "DclaimContractSteps.PendingImportSeed",
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        payloadSha256: payloadSha256(ChainKind.EVM, [
          { native_address: address, wire_atomic: "7" }
        ]),
        expiresAfterChainTimeMs: null
      })
    )
    const invokeViaFileOnce = jest.fn(),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
        wire: {
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "9" }] })
              },
              unmapped: {
                query: jest.fn().mockResolvedValue({
                  rows: [],
                  more: false,
                  nextKey: null
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
          firstUnmappedId: "9",
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
    ).rejects.toThrow(/no safe expiration bound/)
    expect(invokeViaFileOnce).not.toHaveBeenCalled()
    expect(Fs.existsSync(journalPath)).toBe(true)
  })

  it("fails closed when the counter advances while a pending journal expires", async () => {
    const address = "ad".repeat(20),
      journalPath = Path.join(
        dataPath,
        `.dclaim-importseed-${ChainKind.EVM}-0-9.pending.json`
      )
    Fs.writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "DclaimContractSteps.PendingImportSeed",
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        payloadSha256: payloadSha256(ChainKind.EVM, [
          { native_address: address, wire_atomic: "7" }
        ]),
        expiresAfterChainTimeMs: Date.parse("2026-08-27T00:00:00.000Z")
      })
    )

    let expired = false
    const invokeViaFileOnce = jest.fn(),
      capcountersQuery = jest.fn().mockImplementation(async () => ({
        rows: [{ next_unmapped_id: expired ? "10" : "9" }]
      })),
      unmappedQuery = jest.fn().mockResolvedValue({
        rows: [],
        more: false,
        nextKey: null
      }),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
        wire: {
          getInfo: jest.fn().mockImplementation(async () => {
            expired = true
            return {
              head_block_time: "2026-08-27T00:00:01.000",
              head_block_num: 93,
              head_block_id: "block-93"
            }
          }),
          waitForBlockIrreversible: jest.fn().mockResolvedValue(true),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: { query: capcountersQuery },
              unmapped: { query: unmappedQuery }
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
          firstUnmappedId: "9",
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
    ).rejects.toThrow(/counter advanced past an unreconciled batch/)

    expect(capcountersQuery).toHaveBeenCalledTimes(2)
    expect(invokeViaFileOnce).not.toHaveBeenCalled()
    expect(Fs.existsSync(journalPath)).toBe(false)
  })

  it("fails closed when a pending journal belongs to another payload", async () => {
    const address = "ae".repeat(20),
      journalPath = Path.join(
        dataPath,
        `.dclaim-importseed-${ChainKind.EVM}-0-9.pending.json`
      )
    Fs.writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "DclaimContractSteps.PendingImportSeed",
        chain: ChainKind.EVM,
        batchIndex: 0,
        firstUnmappedId: "9",
        creditCount: 1,
        payloadSha256: "0".repeat(64),
        expiresAfterChainTimeMs: Date.parse("2026-08-27T00:03:00.000Z")
      })
    )
    const invokeViaFileOnce = jest.fn(),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 7n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 7n
            }
          ]
        }),
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

    await expect(
      Steps.contracts.sysio.dclaim.runImportSeedBatch(
        context,
        {
          kind: "DclaimContractSteps.ImportSeedBatchInput",
          chain: ChainKind.EVM,
          batchIndex: 0,
          firstUnmappedId: "9",
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
    ).rejects.toThrow(/pending importseed payload changed/)
    expect(invokeViaFileOnce).not.toHaveBeenCalled()
    expect(Fs.existsSync(journalPath)).toBe(true)
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
          firstUnmappedId: "1",
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
          nextKey: '{"id":"18"}'
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
        config: { dataPath },
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
          getInfo: jest.fn().mockResolvedValue({
            head_block_time: "2026-08-27T00:00:00.000"
          }),
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
          firstUnmappedId: "17",
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
      lowerBound: '{"id":"17"}',
      upperBound: '{"id":"19"}',
      limit: 2
    })
    expect(unmappedQuery).toHaveBeenNthCalledWith(2, {
      lowerBound: '{"id":"18"}',
      upperBound: '{"id":"19"}',
      limit: 1
    })
  })

  it("proves matching importseed state irreversible after a raw submission error", async () => {
    const address = "bd".repeat(20),
      transportError = new Error("Connection reset by peer"),
      invokeViaFileOnce = jest.fn().mockRejectedValue(transportError),
      unmappedQuery = jest.fn().mockResolvedValue({
        rows: [
          {
            id: "31",
            chain_kind: ChainKind.EVM,
            native_pubkey: address,
            balance: "0.000000012 WIRE",
            expires_at_sec: 1
          }
        ],
        more: false,
        nextKey: null
      }),
      waitForBlockIrreversible = jest.fn().mockResolvedValue(true),
      context = {
        config: { dataPath },
        outputs: new OutputStore().set(DistributionClaimBootstrapResultKey, {
          chains: [
            {
              chain: ChainKind.EVM,
              sources: [],
              batches: [
                {
                  chain: ChainKind.EVM,
                  credits: [{ native_address: address, wire_atomic: 12n }]
                }
              ],
              droppedDust: 0n,
              eligibleAddressCount: 1,
              totalAtomic: 12n
            }
          ]
        }),
        wire: {
          getInfo: jest
            .fn()
            .mockResolvedValue({
              head_block_time: "2026-08-27T00:00:00.000",
              head_block_num: 73,
              head_block_id: "block-73"
            }),
          waitForBlockIrreversible,
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "31" }] })
              },
              unmapped: { query: unmappedQuery }
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
          firstUnmappedId: "31",
          creditCount: 1,
          summary: {
            ...summary,
            eligibleAddressCount: 1,
            batchCount: 1,
            totalAtomic: "12",
            droppedDust: "0"
          }
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
    expect(unmappedQuery).toHaveBeenCalledTimes(2)
    expect(waitForBlockIrreversible).toHaveBeenCalledWith({
      blockNum: 73,
      blockId: "block-73"
    })
  })

  it("fails closed when matching state after a raw error cannot be proven irreversible", async () => {
    const address = "be".repeat(20),
      transportError = new Error("Failed http request to nodeop"),
      invokeViaFileOnce = jest.fn().mockRejectedValue(transportError),
      context = {
        config: { dataPath },
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
          getInfo: jest
            .fn()
            .mockResolvedValueOnce({
              head_block_time: "2026-08-27T00:00:00.000",
              head_block_num: 79,
              head_block_id: "block-79"
            })
            .mockResolvedValueOnce({
              head_block_time: "2026-08-27T00:00:00.000",
              head_block_num: 79,
              head_block_id: "block-79"
            })
            .mockResolvedValue({
              head_block_time: "2026-08-27T00:03:00.000",
              head_block_num: 80,
              head_block_id: "block-80"
            }),
          waitForBlockIrreversible: jest.fn().mockResolvedValue(false),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "37" }] })
              },
              unmapped: {
                query: jest.fn().mockResolvedValue({
                  rows: [
                    {
                      id: "37",
                      chain_kind: ChainKind.EVM,
                      native_pubkey: address,
                      balance: "0.000000013 WIRE",
                      expires_at_sec: 1
                    }
                  ],
                  more: false,
                  nextKey: null
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
          firstUnmappedId: "37",
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
    ).rejects.toBe(transportError)
    expect(invokeViaFileOnce).toHaveBeenCalledTimes(1)
  })

  it("does not accept matching importseed state before the transaction is irreversible", async () => {
    const address = "cc".repeat(20),
      invokeViaFileOnce = jest.fn().mockRejectedValue(finalityError()),
      context = {
        config: { dataPath },
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
          getInfo: jest
            .fn()
            .mockResolvedValueOnce({
              head_block_time: "2026-08-27T00:00:00.000"
            })
            .mockResolvedValue({
              head_block_time: "2026-08-27T00:03:00.000"
            }),
          isTransactionIrreversible: jest.fn().mockResolvedValue(false),
          getSysioContract: () => ({
            actions: { importseed: { invokeViaFileOnce } },
            tables: {
              capcounters: {
                query: jest
                  .fn()
                  .mockResolvedValue({ rows: [{ next_unmapped_id: "23" }] })
              },
              unmapped: {
                query: jest.fn().mockResolvedValue({
                  rows: [],
                  more: false,
                  nextKey: null
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
          firstUnmappedId: "23",
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

  it("proves importdone state irreversible after a raw submission error", async () => {
    const transportError = new Error("Connection reset by peer"),
      invokeOnce = jest.fn().mockRejectedValue(transportError),
      capcfgQuery = jest
        .fn()
        .mockResolvedValue({ rows: [{ imported_complete: 1 }] }),
      waitForBlockIrreversible = jest.fn().mockResolvedValue(true),
      context = {
        wire: {
          getInfo: jest
            .fn()
            .mockResolvedValue({ head_block_num: 83, head_block_id: "block-83" }),
          waitForBlockIrreversible,
          getSysioContract: () => ({
            actions: { importdone: { invokeOnce } },
            tables: { capcfg: { query: capcfgQuery } }
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
    expect(capcfgQuery).toHaveBeenCalledTimes(2)
    expect(waitForBlockIrreversible).toHaveBeenCalledWith({
      blockNum: 83,
      blockId: "block-83"
    })
  })
})
