import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"
import { RecordingConnection } from "@wireio/cluster-tool/clients/solana"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { StepExtraRecorder } from "@wireio/cluster-tool/report"
import { toURL } from "@wireio/cluster-tool/utils"

function createConnection(endpoint: string): RecordingConnection {
  const connection = new RecordingConnection(endpoint, "confirmed")
  jest.spyOn(connection, "getBlockHeight").mockResolvedValue(1)
  return connection
}

function transfer(signer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1
    })
  )
}

describe("RecordingConnection.sendTransaction", () => {
  let endpoint: string
  beforeAll(async () => {
    endpoint = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it("waits for a different hash when intentional writes would have identical signatures", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      first = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150
      },
      next = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 151
      },
      latest = jest
        .spyOn(connection, "getLatestBlockhash")
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(next),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature"),
      transaction = transfer(signer)

    await connection.sendTransaction(transaction, [signer])
    await connection.sendTransaction(transaction, [signer])

    expect(latest).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0])
    expect(Transaction.from(send.mock.calls[1][0]).verifySignatures()).toBe(
      true
    )
  })

  it("reserves signatures before concurrent identical submissions can send", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      first = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150
      },
      next = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 151
      },
      transaction = transfer(signer),
      duplicate = new Transaction().add(...transaction.instructions),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature")
    jest
      .spyOn(connection, "getLatestBlockhash")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(next)

    await Promise.all([
      connection.sendTransaction(transaction, [signer]),
      connection.sendTransaction(duplicate, [signer])
    ])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0])
  })

  it("captures distinct signed bytes when concurrent calls share a transaction instance", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      transaction = transfer(signer),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature")
    jest
      .spyOn(connection, "getLatestBlockhash")
      .mockResolvedValueOnce({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150
      })
      .mockResolvedValueOnce({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 151
      })

    await Promise.all([
      connection.sendTransaction(transaction, [signer]),
      connection.sendTransaction(transaction, [signer])
    ])

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0])
  })

  it("fails without resubmitting a duplicate if the validator stops advancing", async () => {
    jest.useFakeTimers()
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      transaction = transfer(signer),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature")
    jest.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 150
    })
    await connection.sendTransaction(transaction, [signer])

    const rejected = expect(
      connection.sendTransaction(transaction, [signer])
    ).rejects.toThrow(
      "Unable to obtain a distinct Solana transaction signature"
    )
    await jest.advanceTimersByTimeAsync(
      RecordingConnection.NewBlockhashTimeoutMs
    )
    await rejected

    expect(send).toHaveBeenCalledTimes(1)
  })

  it("retains a failed submission's reservation until its last valid height has passed", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      transaction = transfer(signer),
      first = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150
      },
      next = {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 151
      },
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValue("signature"),
      latest = jest
        .spyOn(connection, "getLatestBlockhash")
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(next)
        .mockResolvedValueOnce(first)
    jest
      .mocked(connection.getBlockHeight)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(150)
      .mockResolvedValueOnce(151)

    await expect(
      connection.sendTransaction(transaction, [signer])
    ).rejects.toThrow("response lost")
    await connection.sendTransaction(transaction, [signer])
    await connection.sendTransaction(transaction, [signer])

    // Equality at height 150 still protects the ambiguous first send. Once
    // height 151 expires it, the old reservation is pruned (a real RPC would
    // reject that expired hash; returning it here observes the cache cleanup).
    expect(latest).toHaveBeenCalledTimes(4)
    expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0])
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[2][0])
  })

  it("refreshes the blockhash after a depot wait shorter than the SDK cache lifetime", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      firstBlockhash = Keypair.generate().publicKey.toBase58(),
      secondBlockhash = Keypair.generate().publicKey.toBase58(),
      clock = jest.spyOn(Date, "now").mockReturnValue(100_000),
      latest = jest
        .spyOn(connection, "getLatestBlockhash")
        .mockResolvedValueOnce({
          blockhash: firstBlockhash,
          lastValidBlockHeight: 150
        })
        .mockResolvedValueOnce({
          blockhash: secondBlockhash,
          lastValidBlockHeight: 300
        }),
      sent: Transaction[] = []
    let acceptedBlockhash = firstBlockhash
    jest
      .spyOn(connection, "sendRawTransaction")
      .mockImplementation(async raw => {
        const transaction = Transaction.from(raw)
        if (transaction.recentBlockhash !== acceptedBlockhash) {
          throw new Error("Blockhash not found")
        }
        expect(transaction.verifySignatures()).toBe(true)
        sent.push(transaction)
        return "signature"
      })

    await connection.sendTransaction(transfer(signer), [signer])
    clock.mockReturnValue(124_650)
    acceptedBlockhash = secondBlockhash
    const next = transfer(signer)
    await expect(connection.sendTransaction(next, [signer])).resolves.toBe(
      "signature"
    )

    expect(latest).toHaveBeenCalledTimes(2)
    expect(latest).toHaveBeenNthCalledWith(1, "confirmed")
    expect(latest).toHaveBeenNthCalledWith(2, "confirmed")
    expect(sent.map(transaction => transaction.recentBlockhash)).toEqual([
      firstBlockhash,
      secondBlockhash
    ])
    expect(next.lastValidBlockHeight).toBe(300)
  })

  it("uses the explicit preflight commitment for the blockhash and preserves send options", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      latest = jest.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 150
      }),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature"),
      options = {
        preflightCommitment: "finalized" as const,
        skipPreflight: false,
        maxRetries: 2
      }

    await connection.sendTransaction(transfer(signer), [signer], options)

    expect(latest).toHaveBeenCalledWith(options.preflightCommitment)
    expect(send).toHaveBeenCalledWith(expect.any(Buffer), options)
  })

  it("preserves a durable nonce and its advance instruction without fetching a blockhash", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      nonce = Keypair.generate().publicKey.toBase58(),
      nonceInstruction = SystemProgram.nonceAdvance({
        noncePubkey: Keypair.generate().publicKey,
        authorizedPubkey: signer.publicKey
      }),
      transaction = transfer(signer),
      latest = jest.spyOn(connection, "getLatestBlockhash"),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature")
    transaction.nonceInfo = { nonce, nonceInstruction }

    await connection.sendTransaction(transaction, [signer])

    const submitted = Transaction.from(send.mock.calls[0][0])
    expect(latest).not.toHaveBeenCalled()
    expect(submitted.recentBlockhash).toBe(nonce)
    expect(submitted.instructions[0].programId).toEqual(
      nonceInstruction.programId
    )
    expect(submitted.instructions[0].data).toEqual(nonceInstruction.data)
    expect(submitted.instructions[0].keys.map(key => key.pubkey)).toEqual(
      nonceInstruction.keys.map(key => key.pubkey)
    )
    expect(submitted.verifySignatures()).toBe(true)
  })

  it("forwards a signed versioned transaction and its options without changing the bytes", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      transaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: Keypair.generate().publicKey.toBase58(),
          instructions: transfer(signer).instructions
        }).compileToV0Message()
      ),
      latest = jest.spyOn(connection, "getLatestBlockhash"),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockResolvedValue("signature"),
      options = { skipPreflight: false, maxRetries: 2 }
    transaction.sign([signer])
    const signed = transaction.serialize()

    await connection.sendTransaction(transaction, options)

    expect(latest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(signed, options)
    expect(transaction.serialize()).toEqual(signed)
  })

  it("records and propagates a blockhash RPC error without submitting", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      error = new Error("blockhash RPC unavailable"),
      send = jest.spyOn(connection, "sendRawTransaction"),
      recorder = new StepExtraRecorder()
    jest.spyOn(connection, "getLatestBlockhash").mockRejectedValue(error)

    await StepExtraRecorder.runWith(recorder, async () => {
      await expect(
        connection.sendTransaction(transfer(signer), [signer])
      ).rejects.toBe(error)
    })

    expect(send).not.toHaveBeenCalled()
    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        client: "solana",
        kind: "transaction",
        raw: false,
        ok: false,
        error: error.message
      })
    )
  })

  it("records and propagates a submission error without retrying the write", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      error = new Error("simulation rejected"),
      recorder = new StepExtraRecorder(),
      send = jest
        .spyOn(connection, "sendRawTransaction")
        .mockRejectedValue(error)
    jest.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 150
    })

    await StepExtraRecorder.runWith(recorder, async () => {
      await expect(
        connection.sendTransaction(transfer(signer), [signer])
      ).rejects.toBe(error)
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        client: "solana",
        kind: "transaction",
        raw: false,
        ok: false,
        error: error.message
      })
    )
  })

  it("records a successful signed submission", async () => {
    const connection = createConnection(endpoint),
      signer = Keypair.generate(),
      recorder = new StepExtraRecorder()
    jest.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 150
    })
    jest.spyOn(connection, "_rpcRequest").mockResolvedValue({
      jsonrpc: "2.0",
      id: "1",
      result: "signature"
    })

    await StepExtraRecorder.runWith(recorder, async () => {
      await connection.sendTransaction(transfer(signer), [signer])
    })

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        client: "solana",
        kind: "transaction",
        raw: false,
        ok: true,
        signature: "signature"
      })
    )
    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        client: "solana",
        kind: "transaction",
        raw: true,
        ok: true,
        signature: "signature"
      })
    )
  })
})
