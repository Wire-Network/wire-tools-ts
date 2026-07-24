import { JsonRpcProvider, Wallet } from "ethers"

import type { EthLoadWallet } from "./ethLoadWallet.js"
import {
  createReserveManager,
  pushRequestSwap,
  type EthSwapAmounts,
  type EthSwapRoute
} from "./ethSwap.js"
import {
  buildRoundMajorRequests,
  runSwaps,
  type SwapLoadResult
} from "./loadRunner.js"

/** Inputs for one Ethereum-sourced load run. */
export interface EthRunOptions {
  /** Ethereum outpost JSON-RPC endpoint. */
  readonly url: string
  /** Deployed ReserveManager contract address. */
  readonly reserveManager: string
  /** Existing WIRE account every swap delivers to. */
  readonly recipient: string
  /** Funded source wallets to drive. */
  readonly wallets: readonly EthLoadWallet[]
  /** Pre-existing source/target route slugs. */
  readonly route: EthSwapRoute
  /** Per-swap ETH value and minimum destination amount. */
  readonly amounts: EthSwapAmounts
  /** Swaps each wallet performs. */
  readonly swapsPerWallet: number
  /** Maximum swaps in flight at once. */
  readonly concurrency: number
}

/**
 * Drive Ethereum EOAs through `requestSwap` swaps at bounded concurrency.
 *
 * Each wallet keeps one signer-bound contract for the whole run. Every swap
 * queues an outpost→depot envelope regardless of whether it later settles or
 * reverts, so this is the inbound OPP load path.
 *
 * @param options Run inputs.
 * @returns Submitted count, accepted transaction hashes, and detailed failures.
 */
export async function runEthSwapLoad(
  options: EthRunOptions
): Promise<SwapLoadResult> {
  const provider = new JsonRpcProvider(options.url),
    requests = buildRoundMajorRequests(options.wallets, options.swapsPerWallet),
    managers = new Map(
      options.wallets.map(wallet => [
        wallet.index,
        createReserveManager(
          options.reserveManager,
          new Wallet(wallet.privateKey, provider)
        )
      ])
    )
  return runSwaps(
    requests,
    options.concurrency,
    async request => {
      const manager = managers.get(request.wallet.index)
      if (manager === undefined)
        throw new Error(`no reserve manager for wallet ${request.wallet.index}`)
      return pushRequestSwap(
        manager,
        options.recipient,
        options.route,
        options.amounts
      )
    },
    wallet => wallet.address
  )
}
