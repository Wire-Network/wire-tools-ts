import { createHash } from "node:crypto"

import { Keypair } from "@solana/web3.js"
import { ethers } from "ethers"
import { ETHBootstrapper } from "@wireio/test-cluster-tool/cluster/ETHBootstrapper.js"

const SysioNameDigits = "12345abcdefghijklmnopqrstuvwxyz" as const

/** Defaults that keep stress users clear of Anvil operator/deployer HD slots. */
export namespace StressIdentityDefaults {
  /** Highest operator-reserved Anvil HD slot in the max 21 batch-op + 100 UW shape. */
  export const OperatorReservedHdSlots = 122
  /** First stress-user Anvil HD slot; changing it changes every stress ETH address. */
  export const EthereumHdStartIndex = 128
  /** Domain separator for deterministic Solana stress-user seeds. */
  export const SolanaSeedDomain = "wire-tools-ts:swap-stress-saturation:solana"
}

/** Deterministic Ethereum stress identity derived from Anvil's mnemonic. */
export type StressEthereumIdentity = {
  /** Zero-based stress identity index. */
  readonly index: number
  /** Anvil mnemonic HD slot used for this identity. */
  readonly hdIndex: number
  /** Checksummed EVM address derived at `hdIndex`. */
  readonly address: string
  /** Raw 20-byte EVM address for OPP recipient payloads. */
  readonly addressBytes: Uint8Array
}

/** Deterministic Solana stress identity derived from a domain-separated seed. */
export type StressSolanaIdentity = {
  /** Zero-based stress identity index. */
  readonly index: number
  /** Base58 Solana public key derived for this identity. */
  readonly publicKey: string
  /** Raw 32-byte ed25519 public key for OPP recipient payloads. */
  readonly publicKeyBytes: Uint8Array
  /** Secret key material for constructing a signer during later stress waves. */
  readonly secretKey: Uint8Array
}

/** Deterministic WIRE recipient account used by ETH-to-WIRE stress swaps. */
export type StressWireIdentity = {
  /** Zero-based stress identity index. */
  readonly index: number
  /** WIRE account name that receives direct depot payout. */
  readonly account: string
  /** Raw WIRE account-name bytes for OPP recipient payloads. */
  readonly accountBytes: Uint8Array
}

/** Paired deterministic identities for one stress batch. */
export type StressIdentities = {
  /** Ethereum identities in index order. */
  readonly ethereum: readonly StressEthereumIdentity[]
  /** Solana identities in index order. */
  readonly solana: readonly StressSolanaIdentity[]
  /** WIRE recipient identities in index order. */
  readonly wire: readonly StressWireIdentity[]
}

/** Options for deterministic stress identity generation. */
export type StressIdentityOptions = {
  /** Number of ETH/SOL identity pairs to generate. */
  readonly count: number
  /** First Anvil HD slot to allocate; defaults past every operator slot. */
  readonly ethereumHdStartIndex?: number
}

/**
 * Generate deterministic ETH/SOL stress identities for package-local unit and flow tests.
 *
 * @param count Number of paired identities to generate.
 * @param ethereumHdStartIndex Optional first Anvil HD slot for ETH identities.
 * @returns Stable ETH and SOL identities in index order.
 * @example createStressIdentities(2)
 */
export function createStressIdentities(
  count: number,
  ethereumHdStartIndex = StressIdentityDefaults.EthereumHdStartIndex
): StressIdentities {
  assertPositiveCount(count)
  const mnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic)
  return {
    ethereum: Array.from({ length: count }, (_value, index) =>
      createEthereumIdentity(mnemonic, ethereumHdStartIndex, index)
    ),
    solana: Array.from({ length: count }, (_value, index) =>
      createSolanaIdentity(index)
    ),
    wire: Array.from({ length: count }, (_value, index) =>
      createWireIdentity(index)
    )
  }
}

/**
 * Generate deterministic ETH/SOL stress identities from an options object.
 *
 * @param options Count and optional ETH HD start slot.
 * @returns Stable ETH and SOL identities in index order.
 */
export function createStressIdentitiesFromOptions(
  options: StressIdentityOptions
): StressIdentities {
  return createStressIdentities(options.count, options.ethereumHdStartIndex)
}

function assertPositiveCount(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError("stress identity count must be positive")
  }
}

function createEthereumIdentity(
  mnemonic: ethers.Mnemonic,
  startHdIndex: number,
  index: number
): StressEthereumIdentity {
  const hdIndex = startHdIndex + index,
    wallet = ethers.HDNodeWallet.fromMnemonic(
      mnemonic,
      `${ETHBootstrapper.DerivationPath}${hdIndex}`
    )
  return {
    index,
    hdIndex,
    address: wallet.address,
    addressBytes: ethers.getBytes(wallet.address)
  }
}

function createSolanaIdentity(index: number): StressSolanaIdentity {
  const seed = createHash("sha256")
      .update(`${StressIdentityDefaults.SolanaSeedDomain}:${index}`)
      .digest(),
    keypair = Keypair.fromSeed(seed)
  return {
    index,
    publicKey: keypair.publicKey.toBase58(),
    publicKeyBytes: keypair.publicKey.toBytes(),
    secretKey: keypair.secretKey
  }
}

function createWireIdentity(index: number): StressWireIdentity {
  const account = `stressw${encodeSysioNameIndex(index, 5)}`
  return { index, account, accountBytes: Buffer.from(account, "utf-8") }
}

function encodeSysioNameIndex(index: number, width: number): string {
  let remaining = index,
    suffix = ""
  for (let position = 0; position < width; position += 1) {
    const digit = remaining % SysioNameDigits.length,
      symbol = SysioNameDigits[digit]
    suffix = `${symbol}${suffix}`
    remaining = Math.floor(remaining / SysioNameDigits.length)
  }
  return suffix
}
