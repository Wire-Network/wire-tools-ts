import { Connection, type TransactionConfirmationStatus } from "@solana/web3.js"
import { confirmSignature } from "@wireio/cluster-tool/clients/solana"
import { BindConfig } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("confirmSignature", () => {
  let connection: Connection
  let statusSpy: jest.SpyInstance
  beforeAll(async () => {
    connection = new Connection(
      toURL(await BindConfig.findAvailable(BindConfig.DefaultSolanaRpc))
    )
  })
  afterEach(() => statusSpy?.mockRestore())

  // Builds a web3 getSignatureStatus response. `confirmationStatus` carries
  // web3's own `TransactionConfirmationStatus` literals (the external API
  // boundary) — `SolanaClient.ConfirmationStatus` mirrors them for our branching.
  const response = (
    confirmationStatus: TransactionConfirmationStatus | undefined,
    err: string | null = null
  ) => ({
    context: { slot: 1 },
    value: { slot: 1, confirmations: 1, err, confirmationStatus }
  })
  const mockStatus = (...args: Parameters<typeof response>) => {
    statusSpy = jest
      .spyOn(connection, "getSignatureStatus")
      .mockResolvedValue(response(...args))
  }

  it("resolves once the tx is confirmed", async () => {
    mockStatus("confirmed")
    await expect(
      confirmSignature(connection, "sig", "test", { intervalMs: 1 })
    ).resolves.toBeUndefined()
  })

  it("throws when the tx reports an error", async () => {
    mockStatus("processed", "tx-error")
    await expect(
      confirmSignature(connection, "sig", "test", { intervalMs: 1 })
    ).rejects.toThrow(/tx failed/)
  })

  it("throws on the deadline when never confirmed", async () => {
    mockStatus("processed")
    await expect(
      confirmSignature(connection, "sig", "test", {
        deadlineMs: 30,
        intervalMs: 5
      })
    ).rejects.toThrow(/not confirmed within/)
  })

  it("invokes the rebroadcast callback while unconfirmed", async () => {
    mockStatus("processed")
    const rebroadcast = jest.fn().mockResolvedValue(undefined)
    await expect(
      confirmSignature(connection, "sig", "test", {
        deadlineMs: 60,
        intervalMs: 5,
        rebroadcastMs: 1,
        rebroadcast
      })
    ).rejects.toThrow()
    expect(rebroadcast).toHaveBeenCalled()
  })
})
