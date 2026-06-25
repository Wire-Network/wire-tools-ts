import type { Connection, Keypair, Transaction } from "@solana/web3.js"
import { log } from "../logger.js"
import { confirmSignature } from "./confirmSignature.js"
import { DefaultSolanaCommitment } from "./SolanaCommitment.js"

/**
 * Sign, send, and confirm `tx`, recovering from a validator that silently drops
 * it. Fetches a fresh blockhash inline (so a stale-blockhash drop can't fail a
 * long-running setup), signs once and keeps the raw bytes, sends them, then
 * defers to {@link confirmSignature} with a `rebroadcast` that re-sends the
 * SAME signed bytes every few seconds. Re-sending identical bytes preserves the
 * signature being polled, so a test-validator that drops the tx still lands it
 * within the deadline instead of polling `conf=undefined` until it times out.
 *
 * This is the canonical "send a Solana tx in the harness" path — prefer it over
 * `connection.sendTransaction(...)` + a bare `confirmSignature`, which has no
 * drop recovery.
 *
 * @param connection Solana RPC connection.
 * @param tx         Transaction to send; `recentBlockhash`/`feePayer` are set here.
 * @param signers    Signers; `signers[0]` is the fee payer.
 * @param label      Human-readable label for log/error messages.
 * @returns the transaction signature.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx:         Transaction,
  signers:    Keypair[],
  label:      string
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash(DefaultSolanaCommitment)
  tx.recentBlockhash = blockhash
  tx.feePayer        = signers[0].publicKey
  tx.sign(...signers)
  const raw = tx.serialize()
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false })
  log.info(`[sendAndConfirm/${label}] sig=${sig}`)
  await confirmSignature(connection, sig, label, {
    rebroadcast: () => connection.sendRawTransaction(raw, { skipPreflight: true })
  })
  return sig
}
