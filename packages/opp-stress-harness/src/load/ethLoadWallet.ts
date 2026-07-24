import { readFileSync, writeFileSync } from "node:fs"

import { Wallet } from "ethers"

/** Schema version of the persisted Ethereum wallet set. */
export const EthLoadWalletFileVersion = 1,
  /** Owner-only file mode; the file holds private keys. */
  EthLoadWalletFileMode = 0o600

/**
 * One Ethereum source wallet — a plain EOA, no on-chain account creation.
 *
 * Ethereum EOAs are free, which is why the ETH-sourced load path needs no
 * privileged provisioning: generating a wallet is generating a keypair.
 */
export interface EthLoadWallet {
  /** Stable position in the wallet set. */
  readonly index: number
  /** Checksummed 20-byte EVM address. */
  readonly address: string
  /** Private key that signs this wallet's swaps and its sweep. */
  readonly privateKey: string
}

/**
 * The persisted Ethereum wallet set carried across `provision`/`run`/`sweep`.
 *
 * Holds private keys, so it is written owner-only and is a secret.
 */
export interface EthLoadWalletFile {
  /** Schema version. */
  readonly version: number
  /** Address that funded the wallets and receives swept ETH. */
  readonly funder: string
  /** The single existing WIRE account every swap delivers to. */
  readonly recipient: string
  /** Generated source wallets in index order. */
  readonly wallets: readonly EthLoadWallet[]
}

/**
 * Generate `count` Ethereum source wallets.
 *
 * Pure client-side keypair generation — no chain access, no privilege.
 *
 * @param count Number of wallets; must be a positive integer.
 * @returns Generated wallets in index order.
 */
export function createEthLoadWallets(count: number): readonly EthLoadWallet[] {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError("eth wallet count must be a positive integer")
  return Array.from({ length: count }, (_unused, index) => {
    const wallet = Wallet.createRandom()
    return { index, address: wallet.address, privateKey: wallet.privateKey }
  })
}

/**
 * Write an Ethereum wallet set to disk with owner-only permissions.
 *
 * @param path Destination path.
 * @param file Wallet set to persist.
 */
export function saveEthLoadWalletFile(
  path: string,
  file: EthLoadWalletFile
): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: EthLoadWalletFileMode
  })
}

/**
 * Read and validate a persisted Ethereum wallet set.
 *
 * @param path Wallet file path.
 * @returns The parsed wallet set.
 * @throws Error when the file is malformed or of an unsupported version.
 */
export function readEthLoadWalletFile(path: string): EthLoadWalletFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`eth wallet file is not an object: ${path}`)
  const file = parsed as Partial<EthLoadWalletFile>
  if (file.version !== EthLoadWalletFileVersion)
    throw new Error(
      `unsupported eth wallet file version ${String(file.version)} in ${path}`
    )
  if (!Array.isArray(file.wallets) || file.wallets.length === 0)
    throw new Error(`eth wallet file contains no wallets: ${path}`)
  if (typeof file.funder !== "string" || typeof file.recipient !== "string")
    throw new Error(`eth wallet file is missing funder or recipient: ${path}`)
  return {
    version: file.version,
    funder: file.funder,
    recipient: file.recipient,
    wallets: file.wallets
  }
}
