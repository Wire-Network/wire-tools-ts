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
import { StepExtraRecorder } from "../../report/StepExtraRecorder.js"

/**
 * A `@solana/web3.js` `Connection` that records every transaction submission
 * and airdrop into the running step's `Report.StepResult.extra` (via
 * {@link StepExtraRecorder}). The harness's tools call
 * `ctx.solana.connection.sendTransaction(...)` / anchor providers built over
 * this connection, so instrumenting the connection captures the whole Solana
 * write surface with zero changes outside `clients/`.
 *
 * Read-class methods (balances, account info, signature polling, …) are NOT
 * recorded — poll loops would balloon `extra` with entries carrying no
 * payload information.
 */
export class RecordingConnection extends Connection {
  constructor(endpoint: string, commitmentOrConfig?: Commitment | ConnectionConfig) {
    super(endpoint, commitmentOrConfig)
  }

  override async sendTransaction(
    transaction: Transaction | VersionedTransaction,
    signersOrOptions?: Signer[] | SendOptions,
    options?: SendOptions
  ): Promise<TransactionSignature> {
    const call = RecordingConnection.toTransactionCall(transaction)
    try {
      // web3.js overloads sendTransaction (legacy vs versioned); the runtime
      // dispatch is by argument shape, so forward verbatim.
      const signature = await (
        super.sendTransaction as (...args: unknown[]) => Promise<TransactionSignature>
      )(transaction, signersOrOptions, options)
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
