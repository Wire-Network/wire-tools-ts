import { SlugName } from "@wireio/sdk-core"
import { Contract, type Wallet } from "ethers"

/** Minimal ABI fragment for the one outpost call the load path makes. */
const RequestSwapAbi = [
  "function requestSwap(uint64 sourceTokenCode, uint64 sourceReserveCode, uint64 targetChainCode, uint64 targetTokenCode, uint64 targetReserveCode, bytes targetRecipient, uint64 targetAmount, uint32 targetToleranceBps) payable"
] as const

/**
 * Swap route slugs for an ETH-sourced swap.
 *
 * All must ALREADY exist on the network; the source token must equal the
 * outpost's configured native token code. The load path references them.
 */
export interface EthSwapRoute {
  /** Native source token slug; must match the outpost's native code, e.g. `ETH`. */
  readonly sourceToken: string
  /** Source reserve slug, e.g. `PRIMARY`. */
  readonly sourceReserve: string
  /** Destination chain slug, e.g. `WIRE`. */
  readonly targetChain: string
  /** Destination token slug, e.g. `WIRE`. */
  readonly targetToken: string
  /** Destination reserve slug, e.g. `PRIMARY`. */
  readonly targetReserve: string
}

/** Per-swap amounts for an ETH-sourced swap. */
export interface EthSwapAmounts {
  /** Source ETH in wei; becomes `msg.value`. Must floor to > 0 depot units (~1e9 wei). */
  readonly valueWei: bigint
  /** Minimum acceptable destination amount in the depot frame; must be > 0. */
  readonly targetAmount: bigint
  /** Variance tolerance in basis points. */
  readonly toleranceBps: number
}

/**
 * Encode a WIRE account name as the `targetRecipient` bytes `requestSwap` takes.
 *
 * The depot parses these as the account's literal string spelling (the
 * canonical `ChainAddress.address` encoding for a WIRE recipient) — raw UTF-8,
 * no length prefix, no packing.
 *
 * @param account WIRE account name, e.g. `loadrecipient`.
 * @returns `0x`-prefixed hex of the name's UTF-8 bytes.
 */
export function encodeWireRecipient(account: string): string {
  return `0x${Buffer.from(account, "utf8").toString("hex")}`
}

/**
 * Bind the outpost `ReserveManager` to one wallet's signer.
 *
 * @param address Deployed ReserveManager contract address.
 * @param signer Wallet that signs (and pays gas + ETH value for) the swap.
 * @returns A contract bound to `signer`.
 */
export function createReserveManager(address: string, signer: Wallet): Contract {
  return new Contract(address, RequestSwapAbi, signer)
}

/**
 * Push one native-ETH `requestSwap` to a WIRE recipient — the ETH load unit.
 *
 * Permissionless; the calling EOA needs only ETH for `value` + gas. The swap
 * queues an outpost→depot `SWAP_REQUEST` envelope, which is the inbound OPP
 * load this path generates. A swap the depot later reverts (e.g. variance)
 * still emitted its inbound envelope, so it still counts as load.
 *
 * @param reserveManager Wallet-bound contract from `createReserveManager`.
 * @param recipient Existing WIRE account name receiving the swapped value.
 * @param route Pre-existing source/target slugs.
 * @param amounts Source ETH value and minimum destination amount.
 * @returns The Ethereum transaction hash once mined.
 */
export async function pushRequestSwap(
  reserveManager: Contract,
  recipient: string,
  route: EthSwapRoute,
  amounts: EthSwapAmounts
): Promise<string> {
  const tx = await reserveManager.requestSwap(
    BigInt(SlugName.from(route.sourceToken)),
    BigInt(SlugName.from(route.sourceReserve)),
    BigInt(SlugName.from(route.targetChain)),
    BigInt(SlugName.from(route.targetToken)),
    BigInt(SlugName.from(route.targetReserve)),
    encodeWireRecipient(recipient),
    amounts.targetAmount,
    amounts.toleranceBps,
    { value: amounts.valueWei }
  )
  await tx.wait()
  return tx.hash
}
