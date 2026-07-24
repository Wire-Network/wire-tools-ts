import type { APIClient } from "@wireio/sdk-core"

import { runChunkedBoundedWorkload } from "../chunkedBoundedWorkload.js"
import type { LoadWallet } from "./loadWallet.js"
import {
  createWalletClient,
  pushSwapFromWire,
  type SwapAmounts,
  type SwapRoute
} from "./swapFromWire.js"

/** One wallet's swap in one round of a load run. */
export interface RoundRequest<Wallet> {
  /** Wallet performing the swap. */
  readonly wallet: Wallet
  /** Zero-based round; each wallet performs one swap per round. */
  readonly round: number
}

/** Aggregate result of a swap load run, source-agnostic. */
export interface SwapLoadResult {
  /** Total swaps attempted. */
  readonly submitted: number
  /** Accepted transaction ids/hashes in completion order. */
  readonly accepted: readonly string[]
  /** Failures with the originating wallet and the chain's reason. */
  readonly failures: readonly SwapFailure[]
}

/** One rejected swap, retaining which wallet and round produced it. */
export interface SwapFailure {
  /** Wallet index that failed. */
  readonly index: number
  /** Wallet identity (WIRE account or EVM address). */
  readonly identity: string
  /** Round the failure occurred in. */
  readonly round: number
  /** Chain or transport reason, never swallowed. */
  readonly reason: string
}

/**
 * Order work round-major so concurrent swaps come from distinct wallets.
 *
 * Wallet-major ordering would put several swaps from the SAME wallet in one
 * concurrency window, where identical action data and a shared reference can
 * collide as a duplicate transaction. Round-major spreads each wallet's swaps
 * across windows.
 *
 * @param wallets Wallets to drive.
 * @param swapsPerWallet Swaps each wallet performs.
 * @returns Requests ordered round-major.
 */
export function buildRoundMajorRequests<Wallet extends { readonly index: number }>(
  wallets: readonly Wallet[],
  swapsPerWallet: number
): readonly RoundRequest<Wallet>[] {
  if (!Number.isInteger(swapsPerWallet) || swapsPerWallet <= 0)
    throw new RangeError("swaps per wallet must be a positive integer")
  return Array.from({ length: swapsPerWallet }, (_unused, round) =>
    wallets.map(wallet => ({ wallet, round }))
  ).flat()
}

/**
 * Drive requests through a bounded-concurrency submitter and summarize.
 *
 * Failures are captured with their chain reason rather than swallowed — a
 * rejected swap is still useful signal, and it may still have emitted its OPP
 * envelope.
 *
 * @param requests Round-major requests.
 * @param concurrency Maximum swaps in flight.
 * @param submit Submits one swap, returning its transaction id/hash.
 * @param identityOf Human identity for a wallet, used in failure reporting.
 * @returns Submitted count, accepted ids, and detailed failures.
 */
export async function runSwaps<Wallet extends { readonly index: number }>(
  requests: readonly RoundRequest<Wallet>[],
  concurrency: number,
  submit: (request: RoundRequest<Wallet>) => Promise<string>,
  identityOf: (wallet: Wallet) => string
): Promise<SwapLoadResult> {
  const outcome = await runChunkedBoundedWorkload<RoundRequest<Wallet>, string>({
    requests,
    concurrency,
    submit
  })
  return {
    submitted: requests.length,
    accepted: outcome.successes.map(success => success.id),
    failures: outcome.failures.map(failure => {
      const request = requests[failure.index]
      return {
        index: request?.wallet.index ?? failure.index,
        identity: request === undefined ? "" : identityOf(request.wallet),
        round: request?.round ?? 0,
        reason: failure.reason
      }
    })
  }
}

/** Inputs for one WIRE-sourced load run. */
export interface LoadRunOptions {
  /** Depot HTTP RPC endpoint. */
  readonly url: string
  /** Provisioned WIRE wallets to drive. */
  readonly wallets: readonly LoadWallet[]
  /** Pre-existing destination route. */
  readonly route: SwapRoute
  /** Per-swap amounts and tolerance. */
  readonly amounts: SwapAmounts
  /** Swaps each wallet performs. */
  readonly swapsPerWallet: number
  /** Maximum swaps in flight at once. */
  readonly concurrency: number
}

/**
 * Drive WIRE wallets through `swapfromwire` swaps at bounded concurrency.
 *
 * Each wallet keeps one signer-bound client for the whole run, so signers never
 * race and clients are not rebuilt per swap.
 *
 * @param options Run inputs.
 * @returns Submitted count, accepted transaction ids, and detailed failures.
 */
export async function runSwapLoad(
  options: LoadRunOptions
): Promise<SwapLoadResult> {
  const requests = buildRoundMajorRequests(options.wallets, options.swapsPerWallet),
    clients = new Map<number, APIClient>(
      options.wallets.map(wallet => [
        wallet.index,
        createWalletClient(options.url, wallet)
      ])
    )
  return runSwaps(
    requests,
    options.concurrency,
    async request => {
      const client = clients.get(request.wallet.index)
      if (client === undefined)
        throw new Error(`no client for wallet ${request.wallet.index}`)
      return pushSwapFromWire(client, request.wallet, options.route, options.amounts)
    },
    wallet => wallet.account
  )
}
