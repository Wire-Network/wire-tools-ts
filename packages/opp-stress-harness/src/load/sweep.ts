import { APIClient } from "@wireio/sdk-core"

import { createWalletClient } from "./swapFromWire.js"
import { transferWire } from "./provision.js"
import { WirePrecision, WireSymbol, type LoadWallet } from "./loadWallet.js"

/** Outcome of sweeping one wallet's residual balance. */
export interface SweepResult {
  /** Wallet index swept. */
  readonly index: number
  /** Account swept. */
  readonly account: string
  /** Base units returned to the destination account. */
  readonly returned: bigint
}

/**
 * Read one account's WIRE balance in 9-decimal base units.
 *
 * @param client Any API client (no signer required).
 * @param account Account to read.
 * @returns The balance in base units; zero when the account holds no row.
 */
export async function readWireBalance(
  client: APIClient,
  account: string
): Promise<bigint> {
  const balances = await client.v1.chain.get_currency_balance(
    "sysio.token",
    account,
    WireSymbol
  )
  const first = (balances as readonly unknown[])[0]
  return first === undefined ? 0n : parseWireAsset(String(first))
}

/**
 * Sweep one wallet's entire residual WIRE back to the starting account.
 *
 * Safe to take the full balance: CPU/NET are drawn from the wallet's ROA
 * policy rather than its token balance, so no dust buffer is required. Signed
 * by the wallet's own key, so the sweep is fully un-privileged.
 *
 * @param url Depot HTTP RPC endpoint.
 * @param wallet Wallet to sweep.
 * @param destination Account receiving the residual balance.
 * @returns What was returned; `returned` is zero when nothing was left.
 */
export async function sweepLoadWallet(
  url: string,
  wallet: LoadWallet,
  destination: string
): Promise<SweepResult> {
  const client = createWalletClient(url, wallet),
    balance = await readWireBalance(client, wallet.account)
  if (balance > 0n)
    await transferWire(
      client,
      wallet.account,
      destination,
      balance,
      "opp-stress load sweep"
    )
  return { index: wallet.index, account: wallet.account, returned: balance }
}

/**
 * Parse a `sysio.token` WIRE asset string into 9-decimal base units.
 *
 * @param asset Asset string such as `0.100000000 WIRE`.
 * @returns The amount in base units.
 */
export function parseWireAsset(asset: string): bigint {
  const [amount] = asset.trim().split(" ")
  if (amount === undefined) return 0n
  const [whole, fraction = ""] = amount.split(".")
  const padded = fraction.padEnd(WirePrecision, "0").slice(0, WirePrecision)
  return BigInt(whole) * 10n ** BigInt(WirePrecision) + BigInt(padded || "0")
}
