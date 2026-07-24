import { readFileSync, writeFileSync } from "node:fs"

import type { LoadWallet } from "./loadWallet.js"

/** Schema version of the persisted wallet set. */
export const LoadWalletFileVersion = 1,
  /** Owner-only file mode; the file holds private keys. */
  LoadWalletFileMode = 0o600

/**
 * The persisted wallet set carried between `provision`, `run`, and `sweep`.
 *
 * Contains private key material for every wallet, so it is written owner-only
 * and should be treated as a secret.
 */
export interface LoadWalletFile {
  /** Schema version for forward compatibility. */
  readonly version: number
  /** Nonce prefix used to provision this set; re-runs stay idempotent. */
  readonly noncePrefix: string
  /** Account that funded the wallets and receives swept balances. */
  readonly funder: string
  /** Provisioned wallets in index order. */
  readonly wallets: readonly LoadWallet[]
}

/**
 * Write a wallet set to disk with owner-only permissions.
 *
 * @param path Destination file path.
 * @param file Wallet set to persist.
 */
export function saveLoadWalletFile(path: string, file: LoadWalletFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: LoadWalletFileMode
  })
}

/**
 * Read and validate a persisted wallet set.
 *
 * @param path Wallet file path.
 * @returns The parsed wallet set.
 * @throws Error when the file is malformed or of an unsupported version.
 */
export function readLoadWalletFile(path: string): LoadWalletFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`wallet file is not an object: ${path}`)
  const file = parsed as Partial<LoadWalletFile>
  if (file.version !== LoadWalletFileVersion)
    throw new Error(
      `unsupported wallet file version ${String(file.version)} in ${path}`
    )
  if (!Array.isArray(file.wallets) || file.wallets.length === 0)
    throw new Error(`wallet file contains no wallets: ${path}`)
  if (typeof file.noncePrefix !== "string" || typeof file.funder !== "string")
    throw new Error(`wallet file is missing noncePrefix or funder: ${path}`)
  return {
    version: file.version,
    noncePrefix: file.noncePrefix,
    funder: file.funder,
    wallets: file.wallets
  }
}
