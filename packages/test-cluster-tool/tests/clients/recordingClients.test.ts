import { ethers } from "ethers"
import { RecordingJsonRpcProvider } from "@wireio/test-cluster-tool/clients/ethereum"
import { RecordingConnection } from "@wireio/test-cluster-tool/clients/solana"
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js"

describe("RecordingJsonRpcProvider.shouldRecord", () => {
  it("records tx submissions + anvil admin methods only", () => {
    expect(RecordingJsonRpcProvider.shouldRecord("eth_sendRawTransaction")).toBe(true)
    expect(RecordingJsonRpcProvider.shouldRecord("eth_sendTransaction")).toBe(true)
    expect(RecordingJsonRpcProvider.shouldRecord("evm_mine")).toBe(true)
    expect(RecordingJsonRpcProvider.shouldRecord("anvil_setBalance")).toBe(true)
    expect(RecordingJsonRpcProvider.shouldRecord("hardhat_reset")).toBe(true)
    expect(RecordingJsonRpcProvider.shouldRecord("eth_call")).toBe(false)
    expect(RecordingJsonRpcProvider.shouldRecord("eth_getBalance")).toBe(false)
    expect(RecordingJsonRpcProvider.shouldRecord("eth_blockNumber")).toBe(false)
  })
})

describe("RecordingJsonRpcProvider.toCall", () => {
  it("decodes a raw transaction submission into payload fields", async () => {
    const wallet = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    )
    const raw = await wallet.signTransaction({
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 12_345n,
      nonce: 0,
      gasLimit: 21_000,
      gasPrice: 1_000_000_000,
      chainId: 31_337
    })
    const call = RecordingJsonRpcProvider.toCall("eth_sendRawTransaction", [raw])
    expect(call.client).toBe("ethereum")
    const transaction = call.transaction as { to: string; value: string }
    expect(transaction.to).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
    expect(transaction.value).toBe("12345")
  })

  it("passes an undecodable raw payload through with just method + params", () => {
    const call = RecordingJsonRpcProvider.toCall("eth_sendRawTransaction", ["0xnotatx"])
    expect(call.method).toBe("eth_sendRawTransaction")
    expect(call.transaction).toBeUndefined()
  })
})

describe("RecordingConnection.toTransactionCall", () => {
  it("captures per-instruction program ids + data from a legacy transaction", () => {
    const from = Keypair.generate(),
      to = Keypair.generate()
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to.publicKey,
        lamports: 1_000
      })
    )
    transaction.feePayer = from.publicKey
    const call = RecordingConnection.toTransactionCall(transaction)
    expect(call.client).toBe("solana")
    expect(call.kind).toBe("transaction")
    const instructions = call.instructions as Array<{ programId: string }>
    expect(instructions).toHaveLength(1)
    expect(instructions[0].programId).toBe(SystemProgram.programId.toBase58())
  })
})

describe("read-path recording", () => {
  it("RecordingFetchProvider records wire RPCs request-only and delegates", async () => {
    const { RecordingFetchProvider } = await import(
      "@wireio/test-cluster-tool/clients/wire"
    )
    const { StepExtraRecorder } = await import("@wireio/test-cluster-tool/report")
    const seen: Array<{ url: string; body: string | undefined }> = []
    const fetchFake = (async (url: string, init: { body?: string }) => {
      seen.push({ url, body: init.body })
      return {
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ head_block_num: 7 })
      }
    }) as unknown as typeof fetch
    const provider = new RecordingFetchProvider("http://127.0.0.1:1", { fetch: fetchFake })
    const recorder = new StepExtraRecorder()
    await StepExtraRecorder.runWith(recorder, async () => {
      await provider.call({
        path: "/v1/chain/get_table_rows",
        params: { code: "sysio.opreg", table: "operators" }
      })
      await provider.call({
        path: "/v1/chain/get_table_rows",
        params: { code: "sysio.opreg", table: "operators" }
      })
    })
    expect(seen.length).toBe(2)
    expect(recorder.calls).toEqual([
      {
        client: "wire",
        kind: "rpc",
        path: "/v1/chain/get_table_rows",
        params: { code: "sysio.opreg", table: "operators" },
        count: 2
      }
    ])
  })

  it("RecordingFetchProvider records params in WIRE form (toJSON honored)", async () => {
    const { RecordingFetchProvider } = await import(
      "@wireio/test-cluster-tool/clients/wire"
    )
    // Antelope value types carry BN internals; their toJSON is the wire form.
    const nameLike = {
      value: { words: [29_005_824, 3_834_021], negative: 0 },
      toJSON: () => "sysio.opreg"
    }
    expect(RecordingFetchProvider.toWireForm({ code: nameLike })).toEqual({
      code: "sysio.opreg"
    })
    expect(RecordingFetchProvider.toWireForm(undefined)).toBeNull()
  })

  it("RecordingConnection records read RPCs request-only via the _rpcRequest wrap", async () => {
    const { RecordingConnection } = await import(
      "@wireio/test-cluster-tool/clients/solana"
    )
    const { StepExtraRecorder } = await import("@wireio/test-cluster-tool/report")
    // The fetch override fails fast — the record happens BEFORE the send, so
    // no live validator is needed and the transport never hangs.
    const offlineFetch = (async () => {
      throw new Error("offline fixture")
    }) as unknown as typeof fetch
    const connection = new RecordingConnection("http://127.0.0.1:1", {
      fetch: offlineFetch
    })
    const transport = connection as unknown as {
      _rpcRequest: (method: string, args: unknown[]) => Promise<unknown>
    }
    const recorder = new StepExtraRecorder()
    await StepExtraRecorder.runWith(recorder, async () => {
      await transport
        ._rpcRequest("getBalance", ["someKey", { commitment: "confirmed" }])
        .catch(() => undefined)
      await transport._rpcRequest("sendTransaction", ["base64wire"]).catch(() => undefined)
    })
    // getBalance recorded; sendTransaction skipped (the rich override owns it).
    expect(recorder.calls).toEqual([
      {
        client: "solana",
        kind: "rpc",
        method: "getBalance",
        args: ["someKey", { commitment: "confirmed" }]
      }
    ])
  })

  it("RecordingJsonRpcProvider records read methods request-only", async () => {
    const { RecordingJsonRpcProvider } = await import(
      "@wireio/test-cluster-tool/clients/ethereum"
    )
    const { StepExtraRecorder } = await import("@wireio/test-cluster-tool/report")
    const { ethers } = await import("ethers")
    // staticNetwork suppresses the provider's own eth_chainId detection so the
    // assertion sees exactly the calls the test makes.
    const provider = new RecordingJsonRpcProvider("http://127.0.0.1:1", undefined, {
      staticNetwork: ethers.Network.from(31_337)
    })
    const recorder = new StepExtraRecorder()
    await StepExtraRecorder.runWith(recorder, async () => {
      await provider.send("eth_getBalance", ["0xabc", "latest"]).catch(() => undefined)
      await provider.send("eth_getBalance", ["0xabc", "latest"]).catch(() => undefined)
    })
    expect(recorder.calls).toEqual([
      {
        client: "ethereum",
        kind: "call",
        method: "eth_getBalance",
        params: ["0xabc", "latest"],
        count: 2
      }
    ])
    await provider.destroy()
  })
})
