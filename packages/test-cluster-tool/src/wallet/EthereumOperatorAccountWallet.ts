import { ethers } from "ethers"
import {
  Bytes,
  type BytesType,
  getCompressedPublicKey,
  KeyType,
  PrivateKey,
  PublicKey,
  Signature
} from "@wireio/sdk-core"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import type { OperatorAccountWallet } from "./OperatorAccountWallet.js"

/**
 * Ethereum-side signing identity for a bootstrapped operator.
 *
 * Backed by an `ethers.HDNodeWallet` derived from
 * `ETHBootstrapper.AnvilMnemonic + DerivationPath + hdIndex`. The
 * uniform sign path goes through `@wireio/sdk-core`'s `PrivateKey` (EM
 * key type, secp256k1 ECDSA on SHA-256(message)). For sending actual
 * Ethereum transactions, call sites can narrow via `instanceof` to reach
 * the embedded `ethWallet` — that path uses ethers' native signer (with
 * EIP-191 / typed-data conventions, gas wiring, nonce mgmt) rather than
 * the digest-only sdk-core signing.
 *
 * The `address` getter returns the standard 0x-prefixed 20-byte ETH
 * address. `publicKey` holds the 33-byte compressed pubkey — same value
 * that `sysio.authex::links` indexed for this operator at bootstrap, so
 * passing it as `OperatorAction.opAddress.address_` round-trips through
 * the depot's `bypubkey` lookup back to `name`.
 */
export class EthereumOperatorAccountWallet implements OperatorAccountWallet {
  readonly chain: ChainKind = ChainKind.ETHEREUM

  /**
   * @param name         WIRE account name registered in `sysio.opreg`.
   * @param operatorType Role (BATCH / UNDERWRITER / …).
   * @param publicKey    33-byte compressed secp256k1 pubkey, wrapped as
   *                     `PUB_EM_*`. Matches the operator's authex link.
   * @param privateKey   secp256k1 32-byte private key, wrapped as
   *                     `PVT_EM_*`. Used for non-transaction signing.
   * @param ethWallet    ethers HD wallet — exposed for ETH tx sends.
   */
  constructor(
    readonly name: string,
    readonly operatorType: OperatorType,
    readonly publicKey: PublicKey,
    readonly privateKey: PrivateKey,
    readonly ethWallet: ethers.HDNodeWallet
  ) {}

  /** 20-byte 0x-prefixed Ethereum address derived from the secp256k1 pubkey. */
  get address(): string {
    return this.ethWallet.address
  }

  /** sdk-core uniform signing — SHA-256(message) → secp256k1 ECDSA → `SIG_EM_*`. */
  sign(message: BytesType): Signature {
    return this.privateKey.signMessage(message)
  }
}

export namespace EthereumOperatorAccountWallet {
  /**
   * Build an Ethereum wallet from an `ethers.HDNodeWallet`, wrapping its
   * key material into sdk-core `PrivateKey` / `PublicKey` so the result
   * satisfies the `OperatorAccountWallet` contract.
   */
  export function fromEthersWallet(
    name: string,
    operatorType: OperatorType,
    ethWallet: ethers.HDNodeWallet
  ): EthereumOperatorAccountWallet {
    const privHex = ethWallet.privateKey.startsWith("0x")
      ? ethWallet.privateKey.slice(2)
      : ethWallet.privateKey
    const privateKey = PrivateKey.regenerate(
      KeyType.EM,
      Bytes.fromString(privHex, "hex")
    )
    const compressedHex = getCompressedPublicKey(ethWallet.signingKey.publicKey)
    const compressed = ethers.getBytes(
      compressedHex.startsWith("0x") ? compressedHex : `0x${compressedHex}`
    )
    const publicKey = PublicKey.from({ type: "EM", compressed })
    return new EthereumOperatorAccountWallet(
      name,
      operatorType,
      publicKey,
      privateKey,
      ethWallet
    )
  }
}
