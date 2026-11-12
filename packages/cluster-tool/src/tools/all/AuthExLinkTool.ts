import { ethers } from "ethers"
import { KeyType, PublicKey, Signature, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { WireClient } from "../../clients/wire/WireClient.js"
import type { EthereumIdentity } from "../../types/KeyPair.js"
import type { SolanaSigner } from "../../types/SolanaSigner.js"
import {
  ethereumKeyPairFromWallet,
  ethereumPublicKeyFromWallet
} from "../../utils/keyPairUtils.js"
import { abiEnumValue } from "../../utils/enumUtils.js"

const { SysioContractName } = SysioContracts

/**
 * Helpers for creating `sysio.authex` cross-chain links (Ethereum EM/secp256k1
 * and Solana ED/Ed25519). The signing logic follows the authex contract's
 * message format + per-chain hash/encoding requirements.
 */
export namespace AuthExLinkTool {
  /**
   * Ethereum (EM) link parameters: the key's Wire-canonical public key
   * (`PUB_EM_…`, read off the stored pair) and ANY ethers signer for it — a
   * local `ethers.Wallet` or the KMS signer `keyPairUtils.ethereumSigner`
   * builds, whose secret never leaves AWS. Nothing here derives the public key
   * from the signer, so a material-less signer links exactly like a wallet.
   */
  export interface EthereumLinkParams {
    chainKind: ChainKind.EVM
    account: string
    publicKey: string
    signer: ethers.Signer
  }

  /**
   * Solana (ED) link parameters — the mirror of {@link EthereumLinkParams}:
   * the key's Wire-canonical public key (`PUB_ED_…`, read off the stored pair)
   * and ANY {@link SolanaSigner} for it — a keypair-backed signer or the KMS
   * signer `keyPairUtils.solanaSigner` builds, whose secret never leaves AWS.
   * Nothing here derives the public key from the signer, so a material-less
   * signer links exactly like a keypair.
   */
  export interface SolanaLinkParams {
    chainKind: ChainKind.SVM
    account: string
    publicKey: string
    signer: SolanaSigner
  }

  /** Parameters for {@link createLink}, discriminated on `chainKind`. */
  export type LinkParams = EthereumLinkParams | SolanaLinkParams

  /** Build the authex `createlink` message: `<pubkey>|<account>|<chainKind>|<nonce>|createlink auth`. */
  function buildLinkMessage(
    publicKeyString: string,
    account: string,
    chainKind: ChainKind,
    nonce: number
  ): string {
    return `${publicKeyString}|${account}|${chainKind}|${nonce}|createlink auth`
  }

  /**
   * Sign for Ethereum (EM) — the signer's `signMessage` over the keccak256
   * digest of the message (ethers applies the EIP-191 prefix to the 32 digest
   * bytes; the KMS signer does the same, so both custody forms produce the
   * signature the authex contract recovers).
   */
  async function signEthereumMessage(
    message: string,
    signer: ethers.Signer
  ): Promise<Signature> {
    const digest = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(message)))
    return Signature.fromHex(await signer.signMessage(digest), KeyType.EM)
  }

  /**
   * Sign for Solana (ED) — the authex contract maps SHA256(message) into printable
   * ASCII [33..126]; the chain's ED25519 verification checks the signature over the
   * LOWERCASE-HEX encoding of that mapped digest. The signer produces the 64-byte
   * detached Ed25519 signature of exactly that payload (pure Ed25519 — what a
   * local key's `PrivateKey.signMessage` and a KMS `ED25519_SHA_512` / `RAW`
   * Sign both compute); it is returned as the 96-byte Wire ED signature (the
   * params' 32-byte pubkey + the 64-byte signature) so `recover()` can extract
   * the key.
   */
  async function signSolanaMessage(
    message: string,
    signer: SolanaSigner,
    publicKey: string
  ): Promise<Signature> {
    const hashBytes = ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(message))),
      mapped = new Uint8Array(hashBytes.length)
    hashBytes.forEach((byte, index) => {
      mapped[index] = 33 + (byte % 94)
    })
    const hexPayload = ethers.toUtf8Bytes(ethers.hexlify(mapped).slice(2))
    return Signature.fromRaw(
      await signer.signMessage(hexPayload),
      KeyType.ED,
      PublicKey.from(publicKey)
    )
  }

  /**
   * Create an authex cross-chain link for a WIRE `account` (ETH `EVM` or SOL `SVM`).
   * Invokes `sysio.authex::createlink`, authorized by `account@active`. The
   * linked key is the params' public key for BOTH chains; the signer only
   * proves it.
   *
   * The depot write itself is signed by kiod — or, when the operator's WIRE key
   * lives in KMS and kiod never holds it, by the signer registered with
   * `WireClient.addSigner` for `account`, through sdk-core with the same
   * finality wait. Nothing here chooses: the client routes on the actor.
   */
  export async function createLink(wire: WireClient, params: LinkParams): Promise<void> {
    // Native discriminated-union narrowing: ts-pattern cannot prove
    // exhaustiveness over the proto `ChainKind` enum's members.
    const { chainKind, account, publicKey: publicKeyString } = params,
      nonce = Date.now(),
      message = buildLinkMessage(publicKeyString, account, chainKind, nonce),
      signature = await (params.chainKind === ChainKind.EVM
        ? signEthereumMessage(message, params.signer)
        : signSolanaMessage(message, params.signer, publicKeyString))

    await wire.getSysioContract(SysioContractName.authex).actions.createlink.invoke(
      {
        // `ChainKind` (proto) and `SysioAuthexChainkind` (ABI mirror) share
        // identical numeric values — resolved through the checked bridge.
        chain_kind: abiEnumValue(SysioContracts.SysioAuthexChainkind, chainKind),
        account,
        sig: signature.toString(),
        pub_key: publicKeyString,
        nonce
      },
      { authorization: [{ actor: account, permission: "active" }] }
    )
  }

  /**
   * A new depositor EM (`PUB_EM_*`) public key from a random ethers wallet. Stands in
   * for the ETH key an NFT depositor supplies; recorded as an authex link, never
   * signed with, so a throwaway wallet suffices. EM key derivation itself lives in
   * `keyPairUtils` (single source; see `one-generic-facade-per-concept`).
   */
  export function newEthereumPubEm(): string {
    return ethereumPublicKeyFromWallet(ethers.Wallet.createRandom()).toString()
  }

  /** A throwaway EM public key plus its canonical 20-byte, lowercase-hex EVM address. */
  export function newEthereumIdentity(): EthereumIdentity {
    const pair = ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
    return {
      publicKey: pair.publicKey,
      nativeAddress: pair.address.slice(2).toLowerCase()
    }
  }
}
