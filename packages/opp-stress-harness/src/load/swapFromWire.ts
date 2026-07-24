import {
  APIClient,
  createClassicSigner,
  PrivateKey,
  SlugName,
  SystemContracts
} from "@wireio/sdk-core"

import type { LoadWallet } from "./loadWallet.js"

/** Underwriting contract that accepts WIRE-sourced swaps. */
const UnderwriteAccount = "sysio.uwrit",
  /** Action that escrows WIRE and queues the depot→outpost swap. */
  SwapFromWireActionName = "swapfromwire",
  /** Permission each wallet signs its own swap with. */
  ActivePermission = "active"

/**
 * Destination route for a WIRE-sourced swap.
 *
 * These are slug codes that must ALREADY be registered on the target network
 * (chain, token, and an ACTIVE reserve with liquidity); the load generator
 * references them, it never creates them.
 */
export interface SwapRoute {
  /** Destination chain slug, e.g. `ETHEREUM`. */
  readonly chain: string
  /** Destination token slug, e.g. `ETH`. */
  readonly token: string
  /** Destination reserve slug, e.g. `PRIMARY`. */
  readonly reserve: string
}

/** Per-swap amounts in their respective base units. */
export interface SwapAmounts {
  /** Source WIRE, 9-decimal base units; must meet `uwconfig.min_fromwire_amount`. */
  readonly wireAmount: bigint
  /** Minimum acceptable destination amount in depot frame; must be > 0. */
  readonly targetAmount: bigint
  /** Variance tolerance in basis points, e.g. 500 for 5%. */
  readonly toleranceBps: number
}

/**
 * Build a signing API client bound to one wallet's key.
 *
 * The signer is bound at construction rather than via `setSigner` so concurrent
 * wallets never race on shared mutable signer state — each wallet drives its
 * own client.
 *
 * @param url Depot HTTP RPC endpoint.
 * @param wallet Wallet whose K1 key signs this client's transactions.
 * @returns An API client that signs as `wallet`.
 */
export function createWalletClient(url: string, wallet: LoadWallet): APIClient {
  return new APIClient({
    url,
    signer: createClassicSigner(PrivateKey.from(wallet.privateKey))
  })
}

/**
 * Push one `sysio.uwrit::swapfromwire` — the load generator's unit of work.
 *
 * Signed by the wallet's own `@active` key (un-privileged). The action escrows
 * the WIRE and queues a depot→outpost swap, which is what produces the OPP
 * envelope traffic under test. A swap that later reverts on variance still
 * emitted its envelope, so it still counts as load.
 *
 * @param client Wallet-bound signing client from `createWalletClient`.
 * @param wallet Source wallet; its matched destination receives the value.
 * @param route Pre-existing destination chain/token/reserve slugs.
 * @param amounts Source and minimum-destination amounts plus tolerance.
 * @returns The accepted transaction id.
 */
export async function pushSwapFromWire(
  client: APIClient,
  wallet: LoadWallet,
  route: SwapRoute,
  amounts: SwapAmounts
): Promise<string> {
  const data: SystemContracts.SysioUwritSwapfromwireAction = {
    user: wallet.account,
    wire_amount: amounts.wireAmount.toString(),
    dst_chain_code: { value: SlugName.from(route.chain) },
    dst_token_code: { value: SlugName.from(route.token) },
    dst_reserve_code: { value: SlugName.from(route.reserve) },
    target_amount: amounts.targetAmount.toString(),
    target_tolerance_bps: amounts.toleranceBps,
    recipient_kind: SystemContracts.SysioUwritChainkind.CHAIN_KIND_EVM,
    recipient_addr: toRecipientHex(wallet.destination.address)
  }
  const result = await client.pushTransaction({
    account: UnderwriteAccount,
    name: SwapFromWireActionName,
    authorization: [{ actor: wallet.account, permission: ActivePermission }],
    data
  })
  return result.transaction_id
}

/** Convert a `0x`-prefixed EVM address to the bare hex the action's bytes field takes. */
export function toRecipientHex(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase()
}
