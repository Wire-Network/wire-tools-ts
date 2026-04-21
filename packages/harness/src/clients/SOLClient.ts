import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL
} from "@solana/web3.js"
import { log } from "../logger.js"
import Bluebird from "bluebird"

/**
 * Client for interacting with a Solana outpost on solana-test-validator.
 */
export class SOLClient {
  public connection: Connection

  constructor(public readonly rpcUrl: string) {
    this.connection = new Connection(rpcUrl, "confirmed")
  }

  /** Get SOL balance of an address. */
  async getBalance(pubkey: PublicKey): Promise<number> {
    const balance = await this.connection.getBalance(pubkey)
    return balance / LAMPORTS_PER_SOL
  }

  /** Airdrop SOL to a pubkey (test-validator only). */
  async airdrop(pubkey: PublicKey, solAmount: number): Promise<string> {
    const sig = await this.connection.requestAirdrop(
      pubkey,
      solAmount * LAMPORTS_PER_SOL
    )
    await this.connection.confirmTransaction(sig)
    return sig
  }

  /** Get the current slot. */
  async getSlot(): Promise<number> {
    return this.connection.getSlot()
  }

  /** Read an account's data (PDA). */
  async getAccountData(pubkey: PublicKey): Promise<Buffer | null> {
    const info = await this.connection.getAccountInfo(pubkey)
    return info?.data ? Buffer.from(info.data) : null
  }

  /**
   * Fetch recent transaction logs for a Solana program.
   *
   * Signatures are fetched in one batch and then resolved serially — parallel
   * `getTransaction` calls regularly trip the test validator's rate limiter
   * and cause flakes, so we keep concurrency at 1.
   *
   * @param programId - Program whose signatures to resolve.
   * @param limit     - Maximum number of recent signatures to inspect (default: 10).
   * @returns One `logMessages` array per transaction that emitted logs; transactions
   *          without logs are skipped entirely.
   */
  async getProgramLogs(programId: PublicKey, limit = 10): Promise<string[][]> {
    const sigs = await this.connection.getSignaturesForAddress(programId, {
      limit
    })
    const logArrays = await Bluebird.mapSeries(sigs, async sig => {
      const tx = await this.connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0
      })
      return tx?.meta?.logMessages
    })
    return logArrays.filter((arr): arr is string[] => Array.isArray(arr))
  }
}
