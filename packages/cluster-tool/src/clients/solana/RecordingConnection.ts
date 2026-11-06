import Assert from "node:assert"
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type ConnectionConfig,
  type SendOptions,
  type Signer,
  type TransactionSignature
} from "@solana/web3.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { scaleTimeoutMs, sleep } from "../../utils/asyncUtils.js"

declare module "@solana/web3.js" {
  interface Connection {
    /**
     * web3.js's JSON-RPC transport — every call on a `Connection` funnels
     * through it, but its own typings mark it private, so consumers cannot see
     * it. Declared here (a real member, merely undeclared upstream) so wrapping
     * it is ordinary typed code instead of an assertion into an invented shape.
     */
    _rpcRequest(method: string, args: unknown[]): Promise<unknown>
  }
}

/**
 * A `@solana/web3.js` `Connection` that records every transaction submission
 * and airdrop into the running step's `Report.StepResult.extra` (via
 * {@link StepExtraRecorder}). The harness's tools call
 * `ctx.solana.connection.sendTransaction(...)` / anchor providers built over
 * this connection, so instrumenting the connection captures the whole Solana
 * write surface with zero changes outside `clients/`.
 *
 * Read-class methods (balances, account info, signature polling, …) record
 * REQUEST-ONLY via an `_rpcRequest` wrap, so identical poll repeats collapse
 * into one `count`ed entry in the recorder instead of ballooning `extra`.
 */
export class RecordingConnection extends Connection {
  /** Reserve signatures before sending; retain ambiguous sends until expiry. */
  private readonly legacyTransactionSignatures = new Map<string, number>()

  constructor(endpoint: string, commitmentOrConfig?: Commitment | ConnectionConfig) {
    super(endpoint, commitmentOrConfig)
    // Every web3.js call funnels through the connection's private
    // `_rpcRequest`; wrapping it here captures the READ surface (the rich
    // overrides below own the send-class methods, so those skip this wrap).
    const original = this._rpcRequest.bind(this)
    this._rpcRequest = async (method, args) => {
      if (!RecordingConnection.RichlyRecordedMethods.has(method)) {
        StepExtraRecorder.record({ client: "solana", kind: "rpc", method, args })
      }
      return original(method, args)
    }
  }

  /**
   * Legacy transactions get a fresh blockhash at the preflight commitment before
   * signing. web3.js caches finalized hashes for 30 seconds, which can outlive
   * their validity on a fast local validator during a depot wait. Sign and send
   * the bytes directly so its legacy send path cannot replace the fresh hash.
   * Durable nonces and caller-signed versioned transactions keep their hashes.
   */
  override async sendTransaction(
    transaction: Transaction | VersionedTransaction,
    signersOrOptions?: Signer[] | SendOptions,
    options?: SendOptions
  ): Promise<TransactionSignature> {
    const call = RecordingConnection.toTransactionCall(transaction)
    try {
      let signature: TransactionSignature
      if (transaction instanceof VersionedTransaction) {
        if (Array.isArray(signersOrOptions)) throw new Error("Invalid arguments")
        signature = await super.sendTransaction(transaction, signersOrOptions)
      } else {
        if (!Array.isArray(signersOrOptions)) throw new Error("Invalid arguments")
        const raw = await this.signLegacyTransaction(transaction, signersOrOptions, options)
        signature = await this.sendRawTransaction(raw, options)
      }
      StepExtraRecorder.record({ ...call, ok: true, signature })
      return signature
    } catch (error) {
      StepExtraRecorder.record({
        ...call,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  /** Fetch fresh hashes, reserve a distinct signature and capture its signed bytes. */
  private async signLegacyTransaction(
    transaction: Transaction,
    signers: Signer[],
    options?: SendOptions
  ): Promise<Buffer> {
    if (transaction.nonceInfo != null) {
      transaction.sign(...signers)
      return transaction.serialize()
    }
    const commitment = options?.preflightCommitment ?? this.commitment,
      height = await this.getBlockHeight(commitment),
      timeoutMs = scaleTimeoutMs(RecordingConnection.NewBlockhashTimeoutMs),
      deadline = Date.now() + timeoutMs
    for (const [signature, lastValidBlockHeight] of this.legacyTransactionSignatures) {
      if (height > lastValidBlockHeight) this.legacyTransactionSignatures.delete(signature)
    }
    do {
      const latest = await this.getLatestBlockhash(commitment)
      transaction.recentBlockhash = latest.blockhash
      transaction.lastValidBlockHeight = latest.lastValidBlockHeight
      transaction.sign(...signers)
      const signature = transaction.signature?.toString("base64")
      Assert.ok(signature, "Solana transaction has no signature")
      // No await between checking and reserving: concurrent callers must not
      // submit identical bytes. Failed sends retain the reservation too.
      if (!this.legacyTransactionSignatures.has(signature)) {
        this.legacyTransactionSignatures.set(signature, latest.lastValidBlockHeight)
        return transaction.serialize()
      }
      await sleep(RecordingConnection.NewBlockhashPollIntervalMs)
    } while (Date.now() < deadline)
    throw new Error(`Unable to obtain a distinct Solana transaction signature within ${timeoutMs}ms`)
  }

  override async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | number[],
    options?: SendOptions
  ): Promise<TransactionSignature> {
    const call: StepExtraRecorder.ClientCall = {
      client: "solana",
      kind: "transaction",
      raw: true,
      byteLength: rawTransaction.length
    }
    try {
      const signature = await super.sendRawTransaction(rawTransaction, options)
      StepExtraRecorder.record({ ...call, ok: true, signature })
      return signature
    } catch (error) {
      StepExtraRecorder.record({
        ...call,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  override async requestAirdrop(
    to: PublicKey,
    lamports: number
  ): Promise<TransactionSignature> {
    const call: StepExtraRecorder.ClientCall = {
      client: "solana",
      kind: "airdrop",
      to: to.toBase58(),
      lamports
    }
    try {
      const signature = await super.requestAirdrop(to, lamports)
      StepExtraRecorder.record({ ...call, ok: true, signature })
      return signature
    } catch (error) {
      StepExtraRecorder.record({
        ...call,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

export namespace RecordingConnection {
  /** Match the SDK's ten-second polling window for a distinct blockhash. */
  export const NewBlockhashTimeoutMs = 10_000
  /** Poll twice per nominal Solana slot, as the SDK does. */
  export const NewBlockhashPollIntervalMs = 200

  /**
   * Raw RPC method names the rich overrides (sendTransaction /
   * sendRawTransaction / requestAirdrop) already record with decoded
   * payloads — the `_rpcRequest` read wrap skips these to avoid duplicates.
   */
  export const RichlyRecordedMethods: ReadonlySet<string> = new Set([
    "sendTransaction",
    "requestAirdrop"
  ])

  /**
   * The `extra` record for a (legacy or versioned) transaction submission —
   * per-instruction program ids + data bytes, the actual payload the chain
   * executes.
   */
  export function toTransactionCall(
    transaction: Transaction | VersionedTransaction
  ): StepExtraRecorder.ClientCall {
    const call: StepExtraRecorder.ClientCall = {
      client: "solana",
      kind: "transaction",
      raw: false
    }
    try {
      if (transaction instanceof VersionedTransaction) {
        const keys = transaction.message.staticAccountKeys
        call.instructions = transaction.message.compiledInstructions.map(ix => ({
          programId: keys[ix.programIdIndex]?.toBase58() ?? null,
          dataBase64: Buffer.from(ix.data).toString("base64")
        }))
      } else {
        call.feePayer = transaction.feePayer?.toBase58() ?? null
        call.instructions = transaction.instructions.map(ix => ({
          programId: ix.programId.toBase58(),
          keys: ix.keys.map(k => k.pubkey.toBase58()),
          dataBase64: Buffer.from(ix.data).toString("base64")
        }))
      }
    } catch {
      // Best-effort decode — the submission itself still records.
    }
    return call
  }
}
