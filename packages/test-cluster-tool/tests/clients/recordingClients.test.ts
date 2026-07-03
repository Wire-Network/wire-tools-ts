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
