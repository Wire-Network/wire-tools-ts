import {
  type Commitment,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey
} from "@solana/web3.js"
import { getAccount } from "@solana/spl-token"
import Bluebird from "bluebird"
import { getLogger } from "@wireio/shared"
import { SolanaWallet } from "./SolanaWallet.js"

const log = getLogger(__filename)

/**
 * Client for the Solana outpost on solana-test-validator. Folds the former
 * `sol/SolanaCommitment.ts` into the companion namespace
 * ({@link SolanaClient.DefaultCommitment} + {@link SolanaClient.ConfirmationStatus}).
 */
export class SolanaClient {
  readonly connection: Connection
  readonly wallet: SolanaWallet

  constructor(
    readonly rpcUrl: string,
    wallet: SolanaWallet,
    commitment: Commitment = SolanaClient.DefaultCommitment
  ) {
    this.connection = new Connection(rpcUrl, commitment)
    this.wallet = wallet
  }

  /** SOL balance of an address. */
  getBalance(pubkey: PublicKey): Promise<number> {
    return this.connection.getBalance(pubkey).then(lamports => lamports / LAMPORTS_PER_SOL)
  }

  /** Raw lamport balance (no SOL conversion) — for exact-precision assertions. */
  getLamports(pubkey: PublicKey): Promise<number> {
    return this.connection.getBalance(pubkey)
  }

  /**
   * SPL token balance of an associated token account — `0n` when the account
   * does not exist yet (the normal pre-fund state).
   *
   * @param associatedTokenAddress - The owner's ATA for the mint.
   * @returns The raw token amount.
   */
  async getSplBalance(associatedTokenAddress: PublicKey): Promise<bigint> {
    try {
      return (await getAccount(this.connection, associatedTokenAddress)).amount
    } catch (error) {
      // A missing ATA is the expected pre-fund case — breadcrumb, not a failure.
      log.debug(
        `getSplBalance(${associatedTokenAddress.toBase58()}): ${error instanceof Error ? error.message : String(error)}`
      )
      return 0n
    }
  }

  /** Airdrop SOL to a pubkey (test-validator only). */
  async airdrop(pubkey: PublicKey, solAmount: number): Promise<string> {
    const signature = await this.connection.requestAirdrop(
      pubkey,
      solAmount * LAMPORTS_PER_SOL
    )
    await this.connection.confirmTransaction(signature)
    return signature
  }

  /** Current slot. */
  getSlot(): Promise<number> {
    return this.connection.getSlot()
  }

  /** Read an account's (PDA's) data, or null when absent. */
  async getAccountData(pubkey: PublicKey): Promise<Buffer | null> {
    const info = await this.connection.getAccountInfo(pubkey)
    return info?.data != null ? Buffer.from(info.data) : null
  }

  /**
   * Recent transaction logs for a program. Signatures are fetched in one batch
   * then resolved SERIALLY — parallel `getTransaction` calls trip the test
   * validator's rate limiter.
   *
   * @param programId - Program whose signatures to resolve.
   * @param limit - Maximum recent signatures to inspect.
   * @returns One `logMessages` array per transaction that emitted logs.
   */
  async getProgramLogs(programId: PublicKey, limit = 10): Promise<string[][]> {
    const signatures = await this.connection.getSignaturesForAddress(programId, {
      limit
    })
    const logArrays = await Bluebird.mapSeries(
      signatures,
      async signature =>
        (
          await this.connection.getTransaction(signature.signature, {
            maxSupportedTransactionVersion: 0
          })
        )?.meta?.logMessages ?? null
    )
    return logArrays.filter((array): array is string[] => Array.isArray(array))
  }
}

export namespace SolanaClient {
  /**
   * Default commitment for every harness-created `Connection` (and anchor
   * provider). `finalized` slows every RPC round-trip; `processed` lets polls
   * observe roll-back-able state.
   */
  export const DefaultCommitment: Commitment = "confirmed"

  /**
   * Solana confirmation levels — web3.js ships only literal types, so branch on
   * these members (renames propagate; raw strings do not). Kept in lock-step
   * with {@link DefaultCommitment}.
   */
  export enum ConfirmationStatus {
    processed = "processed",
    confirmed = "confirmed",
    finalized = "finalized"
  }
}
