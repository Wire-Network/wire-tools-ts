import {
  Connection,
  Keypair,
  TransactionMessage,
  type ConfirmedSignatureInfo,
  type TransactionConfirmationStatus,
  type VersionedTransactionResponse
} from "@solana/web3.js"
import {
  confirmSignature,
  readSignaturesSince,
  readTransactionHistory,
  SolanaClient,
  SolanaHistoryRpcError
} from "@wireio/cluster-tool/clients/solana"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("shared Solana history reads", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
  })
  afterEach(() => jest.restoreAllMocks())

  function createHistoryConnection(
    signatures: Connection["getSignaturesForAddress"],
    transactions: (
      ...args: Parameters<Connection["getTransaction"]>
    ) => ReturnType<Connection["getTransaction"]>
  ): Connection {
    const connection = new Connection(rpcUrl)
    jest
      .spyOn(connection, "getSignaturesForAddress")
      .mockImplementation(signatures)
    jest.spyOn(connection, "getTransaction").mockImplementation(transactions)
    return connection
  }

  const address = Keypair.generate().publicKey,
    signature = (index: number): ConfirmedSignatureInfo => ({
      signature: `signature-${index}`,
      slot: index,
      err: null,
      memo: null,
      blockTime: null
    }),
    message = new TransactionMessage({
      payerKey: address,
      recentBlockhash: address.toBase58(),
      instructions: []
    }).compileToV0Message(),
    transaction = (index: number): VersionedTransactionResponse => ({
      slot: index,
      blockTime: null,
      version: 0,
      transaction: { message, signatures: [`signature-${index}`] },
      meta: { err: null, fee: 0, preBalances: [], postBalances: [] }
    })

  it.each([
    SolanaClient.ConfirmationStatus.confirmed,
    SolanaClient.ConfirmationStatus.finalized
  ] as const)(
    "pages a full first page through a short terminal page at %s",
    async commitment => {
      const first = Array.from(
          { length: readSignaturesSince.PageSize },
          (_, index) => signature(index + 1)
        ).reverse(),
        pages = jest
          .fn()
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce([signature(0)]),
        result = await readSignaturesSince(pages, address, 0, commitment, 2)
      expect(result).toEqual([...first, signature(0)])
      expect(pages).toHaveBeenNthCalledWith(
        1,
        address,
        { limit: readSignaturesSince.PageSize },
        commitment
      )
      expect(pages).toHaveBeenNthCalledWith(
        2,
        address,
        { limit: readSignaturesSince.PageSize, before: "signature-1" },
        commitment
      )
    }
  )

  it("requires a terminal empty page after an exactly full history", async () => {
    const first = Array.from(
        { length: readSignaturesSince.PageSize },
        (_, index) => signature(index)
      ),
      pages = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([])
    await expect(
      readSignaturesSince(
        pages,
        address,
        0,
        SolanaClient.ConfirmationStatus.finalized,
        2
      )
    ).resolves.toEqual(first)
    expect(pages).toHaveBeenCalledTimes(2)
  })

  it("keeps the marker slot and stops before earlier signatures", async () => {
    const pages = jest
      .fn()
      .mockResolvedValue([signature(11), signature(10), signature(9)])
    await expect(readSignaturesSince(pages, address, 10)).resolves.toEqual([
      signature(11),
      signature(10)
    ])
    expect(pages).toHaveBeenCalledTimes(1)
    expect(pages.mock.calls[0][2]).toBe("confirmed")
  })

  it("refuses two full pages instead of returning a partial history", async () => {
    const pages = jest
        .fn()
        .mockResolvedValue(
          Array.from({ length: readSignaturesSince.PageSize }, (_, index) =>
            signature(index)
          )
        ),
      promise = readSignaturesSince(
        pages,
        address,
        0,
        SolanaClient.ConfirmationStatus.finalized,
        2
      )
    await expect(promise).rejects.toThrow(
      /runs past 2 pages of 1000 signatures/
    )
    await promise.catch(error =>
      expect(error).not.toBeInstanceOf(SolanaHistoryRpcError)
    )
    expect(pages).toHaveBeenCalledTimes(2)
  })

  it("reads finalized transactions serially in chronological order", async () => {
    let active = 0
    const requests: string[] = [],
      signatures = jest
        .fn()
        .mockResolvedValue([signature(2), signature(1), signature(0)]),
      transactions = jest.fn(
        async (
          value: string,
          _options: Parameters<Connection["getTransaction"]>[1]
        ) => {
          expect(++active).toBe(1)
          requests.push(value)
          await Promise.resolve()
          active--
          return transaction(Number(value.split("-")[1]))
        }
      ),
      connection = createHistoryConnection(signatures, transactions)
    await expect(
      readTransactionHistory(
        connection,
        address,
        SolanaClient.ConfirmationStatus.finalized,
        2
      )
    ).resolves.toEqual([transaction(0), transaction(1), transaction(2)])
    expect(requests).toEqual(["signature-0", "signature-1", "signature-2"])
    expect(signatures.mock.calls[0][2]).toBe("finalized")
    for (const call of transactions.mock.calls)
      expect(call[1]).toEqual({
        commitment: "finalized",
        maxSupportedTransactionVersion: 0
      })
  })

  it.each([null, { ...transaction(0), meta: null }])(
    "refuses unavailable transaction evidence",
    async response => {
      const connection = createHistoryConnection(
        jest.fn().mockResolvedValue([signature(0)]),
        jest.fn().mockResolvedValue(response)
      )
      await expect(
        readTransactionHistory(
          connection,
          address,
          SolanaClient.ConfirmationStatus.finalized,
          2
        )
      ).resolves.toBeUndefined()
    }
  )

  it("wraps only a failed signature RPC with its original cause", async () => {
    const cause = new Error("connection reset"),
      signatures = jest.fn().mockRejectedValue(cause)
    await expect(
      readSignaturesSince(signatures, address)
    ).rejects.toMatchObject({
      name: SolanaHistoryRpcError.name,
      cause,
      message: expect.stringContaining("getSignaturesForAddress")
    })
  })

  it("identifies a failed transaction RPC by signature", async () => {
    const cause = new Error("request timed out"),
      connection = createHistoryConnection(
        jest.fn().mockResolvedValue([signature(7)]),
        jest.fn().mockRejectedValue(cause)
      )
    await expect(
      readTransactionHistory(
        connection,
        address,
        SolanaClient.ConfirmationStatus.finalized,
        2
      )
    ).rejects.toMatchObject({
      name: SolanaHistoryRpcError.name,
      cause,
      message: expect.stringContaining("getTransaction(signature-7)")
    })
  })
})

describe("confirmSignature", () => {
  let connection: Connection
  let statusSpy: jest.SpyInstance
  beforeAll(async () => {
    connection = new Connection(
      toURL(
        await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaRpc
        )
      )
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

  it("throws when a CONFIRMED tx carries an error — inclusion is not success", async () => {
    // A transaction the runtime processed with an error is still included in a
    // block, so its status reaches `confirmed` too. Returning on the status
    // reported an on-chain `EpochRewardsActive` deposit refusal as OK, and the
    // step after it found the token account that deposit never created.
    mockStatus("confirmed", "tx-error")
    await expect(
      confirmSignature(connection, "sig", "test", { intervalMs: 1 })
    ).rejects.toThrow(/tx failed/)
  })

  it("throws when a FINALIZED tx carries an error", async () => {
    mockStatus("finalized", "tx-error")
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
