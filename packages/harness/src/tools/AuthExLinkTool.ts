/**
 * AuthExLinkTool — reusable functions for creating sysio.authex cross-chain links.
 *
 * Supports Ethereum (EM/secp256k1) and Solana (ED/Ed25519) key linking.
 * The signing logic for each chain follows the authex contract's message
 * format and hash algorithm requirements.
 */

import { ethers } from "ethers"
import {
  Bytes,
  Checksum256,
  getCompressedPublicKey,
  KeyType,
  PrivateKey,
  PublicKey,
  Signature
} from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { Clio } from "../clients/Clio.js"
import Assert from "node:assert"

export interface LinkParams {
  chainKind: ChainKind
  account: string
  privateKey: PrivateKey
  /** For ETH: the ethers wallet (for pubkey derivation via getCompressedPublicKey) */
  ethWallet?: ethers.HDNodeWallet
}

/**
 * Build the authex createlink message string.
 * Format: "<pubkey_string>|<account>|<chain_kind>|<nonce>|createlink auth"
 */
function buildLinkMessage(
  pubKeyString: string,
  account: string,
  chainKind: ChainKind,
  nonce: number
): string {
  return `${pubKeyString}|${account}|${chainKind}|${nonce}|createlink auth`
}

/**
 * Sign a createlink message for Ethereum (EM / secp256k1).
 * Signs keccak256(msg) directly via the SDK's PrivateKey.signDigest
 * (no EIP-191 prefix — the default behavior after the Sign.ts fix).
 */
async function signEthereumMessage(
  privateKey: PrivateKey,
  message: string,
  wallet: ethers.HDNodeWallet
): Promise<Signature> {
  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(message))
  const digest = ethers.getBytes(msgHash)
  return Signature.fromHex(await wallet.signMessage(digest), KeyType.EM)
}

/**
 * Sign a createlink message for Solana (ED / Ed25519).
 * The authex contract expects SHA256 of the message mapped to ASCII [33..126],
 * then signed with the Ed25519 key.
 */
async function signSolanaMessage(
  privateKey: PrivateKey,
  message: string
): Promise<Signature> {
  const sha256Hash = ethers.sha256(ethers.toUtf8Bytes(message))
  const hashBytes = ethers.getBytes(sha256Hash)
  const mapped = new Uint8Array(hashBytes.length)
  hashBytes.forEach((b, i) => {
    mapped[i] = 33 + (b % 94)
  })
  const sig64 = privateKey.signMessage(Bytes.from(mapped))

  // Wire/sysio ED25519 signatures are 96 bytes: 32-byte embedded public key
  // followed by 64-byte signature. This allows recover() to extract the
  // pubkey since ED25519 is not mathematically recoverable like ECDSA.
  const pubKeyBytes = privateKey.toPublic().data.array
  const sig96 = new Uint8Array(96)
  sig96.set(pubKeyBytes, 0)
  sig96.set(sig64.data.array, 32)
  return new Signature(KeyType.ED, Bytes.from(sig96))
}

/**
 * Create an authex cross-chain link for a WIRE account.
 * Works for both Ethereum (chainKind=2) and Solana (chainKind=3).
 */
export async function createAuthExLink(
  clio: Clio,
  params: LinkParams
): Promise<void> {
  const { chainKind, account, privateKey, ethWallet } = params
  // For ETH: derive pubkey from ethers wallet (ensures compressed key matches).
  // For other chains: derive from the PrivateKey.
  const publicKey =
    chainKind === ChainKind.ETHEREUM && ethWallet
      ? emPublicKeyFromEthWallet(ethWallet)
      : privateKey.toPublic()
  const pubKeyString = publicKey.toString()
  const nonce = Date.now()

  const message = buildLinkMessage(pubKeyString, account, chainKind, nonce)

  const signature = await (chainKind === ChainKind.ETHEREUM && ethWallet
    ? signEthereumMessage(privateKey, message, ethWallet)
    : signSolanaMessage(privateKey, message))


  await clio.pushAction(
    "sysio.authex",
    "createlink",
    {
      chain_kind: chainKind,
      account,
      sig: signature.toString(),
      pub_key: pubKeyString,
      nonce
    },
    `${account}@active`
  )
}

/**
 * Derive an EM (secp256k1) PrivateKey from an ethers HDNodeWallet.
 */
export function emPrivateKeyFromEthWallet(
  wallet: ethers.HDNodeWallet
): PrivateKey {
  const privKeyStr = wallet.privateKey.startsWith("0x")
    ? wallet.privateKey.slice(2)
    : wallet.privateKey
  const privKeyData = Bytes.fromString(privKeyStr, "hex")
  return PrivateKey.regenerate(KeyType.EM, privKeyData)
}

/**
 * Build a WIRE PublicKey (PUB_EM_*) from an ethers wallet's uncompressed public key.
 * Uses getCompressedPublicKey to compress, then constructs the PublicKey object.
 * Uses getCompressedPublicKey to compress, then constructs the PublicKey object.
 */
export function emPublicKeyFromEthWallet(
  wallet: ethers.HDNodeWallet
): PublicKey {
  const uncompressedWithPrefix = wallet.signingKey.publicKey
  const compressed = getCompressedPublicKey(uncompressedWithPrefix)
  const compressedHex = compressed.startsWith("0x")
    ? compressed.slice(2)
    : compressed
  const compressedBytes = ethers.getBytes("0x" + compressedHex)
  // CDT normalizes compressed secp256k1 keys to 0x02 prefix during ABI
  // deserialization. Force 0x02 so the JS message string matches the
  // contract's pubkey_to_string output. The authex contract stores the
  // recovered key (with real prefix) for correct downstream address derivation.
  compressedBytes[0] = 0x02
  return PublicKey.from({
    type: "EM",
    compressed: compressedBytes
  })
}
