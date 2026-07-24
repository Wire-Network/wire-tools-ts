import { JsonRpcProvider, Wallet, type TransactionResponse } from "ethers"

import type { EthLoadWallet } from "./ethLoadWallet.js"

/** Gas units a plain ETH value transfer consumes. */
export const EthTransferGas = 21_000n

/** Outcome of sweeping one Ethereum wallet's residual ETH. */
export interface EthSweepResult {
  /** Wallet index swept. */
  readonly index: number
  /** Wallet address swept. */
  readonly address: string
  /** Wei returned to the funder (zero when the balance could not cover gas). */
  readonly returned: bigint
}

/**
 * Fund one Ethereum source wallet from the funder wallet.
 *
 * @param funder Signer holding ETH, connected to the network.
 * @param address Destination wallet address.
 * @param amountWei Amount to send, in wei.
 * @returns The broadcast transaction (await `.wait()` for inclusion).
 */
export function fundEthWallet(
  funder: Wallet,
  address: string,
  amountWei: bigint
): Promise<TransactionResponse> {
  return funder.sendTransaction({ to: address, value: amountWei })
}

/**
 * Wei that can be swept after retaining exactly one ETH transfer's gas.
 *
 * @param balanceWei Current wallet balance in wei.
 * @param gasPriceWei Gas price the sweep transfer will pay.
 * @returns The sendable amount, or 0 when the balance cannot cover gas.
 */
export function sweepableWei(balanceWei: bigint, gasPriceWei: bigint): bigint {
  const sendable = balanceWei - EthTransferGas * gasPriceWei
  return sendable > 0n ? sendable : 0n
}

/**
 * Sweep one wallet's residual ETH back to the funder, less the transfer's gas.
 *
 * Unlike WIRE (where CPU/NET come from ROA), an ETH transfer costs gas paid
 * from the same balance, so the sweep must retain exactly one transfer's gas
 * and send the remainder. Wallets whose balance cannot cover that gas are left
 * as dust and reported with `returned = 0`.
 *
 * @param provider Network provider.
 * @param wallet Wallet to sweep.
 * @param to Funder address receiving the residual ETH.
 * @param gasPriceWei Gas price to price the retained gas at.
 * @returns What was returned; zero when the balance was below gas cost.
 */
export async function sweepEthWallet(
  provider: JsonRpcProvider,
  wallet: EthLoadWallet,
  to: string,
  gasPriceWei: bigint
): Promise<EthSweepResult> {
  const signer = new Wallet(wallet.privateKey, provider),
    balance = await provider.getBalance(wallet.address),
    sendable = sweepableWei(balance, gasPriceWei)
  if (sendable === 0n)
    return { index: wallet.index, address: wallet.address, returned: 0n }
  const tx = await signer.sendTransaction({
    to,
    value: sendable,
    gasLimit: EthTransferGas,
    gasPrice: gasPriceWei
  })
  await tx.wait()
  return { index: wallet.index, address: wallet.address, returned: sendable }
}

/**
 * Resolve the network's current gas price in wei.
 *
 * @param provider Network provider.
 * @returns The gas price, defaulting to 1 gwei when the node reports none.
 */
export async function resolveGasPrice(
  provider: JsonRpcProvider
): Promise<bigint> {
  const fee = await provider.getFeeData()
  return fee.gasPrice ?? 1_000_000_000n
}
