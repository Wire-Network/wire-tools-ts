import { ethers } from "ethers"
import { Bytes, KeyType, PrivateKey, Signature, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { WireClient } from "../../clients/wire/WireClient.js"
import { ethereumPublicKeyFromWallet } from "../../utils/keyPairUtils.js"
import { abiEnumValue } from "../../utils/enumUtils.js"

const { SysioContractName } = SysioContracts

/**
 * Helpers for creating `sysio.authex` cross-chain links (Ethereum EM/secp256k1
 * and Solana ED/Ed25519). The signing logic follows the authex contract's
 * message format + per-chain hash/encoding requirements.
 */
export namespace AuthExLinkTool {
  /** Parameters for {@link createLink}. */
  export interface LinkParams {
    chainKind: ChainKind
    account: string
    privateKey: PrivateKey
    /** For ETH: the ethers wallet (compressed-pubkey derivation must match). */
    ethereumWallet?: ethers.BaseWallet
  }

  /** Build the authex `createlink` message: `<pubkey>|<account>|<chainKind>|<nonce>|createlink auth`. */
  function buildLinkMessage(
    publicKeyString: string,
    account: string,
    chainKind: ChainKind,
    nonce: number
  ): string {
    return `${publicKeyString}|${account}|${chainKind}|${nonce}|createlink auth`
  }

  /** Sign for Ethereum (EM) — keccak256(message), no EIP-191 prefix. */
  async function signEthereumMessage(
    message: string,
    ethereumWallet: ethers.BaseWallet
  ): Promise<Signature> {
    const digest = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(message)))
    return Signature.fromHex(await ethereumWallet.signMessage(digest), KeyType.EM)
  }

  /**
   * Sign for Solana (ED) — the authex contract maps SHA256(message) into printable
   * ASCII [33..126]; the chain's ED25519 verification checks the signature over the
   * LOWERCASE-HEX encoding of that mapped digest. Returns a 96-byte Wire ED signature
   * (32-byte embedded pubkey + 64-byte signature) so `recover()` can extract the key.
   */
  async function signSolanaMessage(
    privateKey: PrivateKey,
    message: string
  ): Promise<Signature> {
    const hashBytes = ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(message))),
      mapped = new Uint8Array(hashBytes.length)
    hashBytes.forEach((byte, index) => {
      mapped[index] = 33 + (byte % 94)
    })
    const hexPayload = ethers.toUtf8Bytes(ethers.hexlify(mapped).slice(2)),
      signature64 = privateKey.signMessage(Bytes.from(hexPayload)),
      publicKeyBytes = privateKey.toPublic().data.array,
      signature96 = new Uint8Array(96)
    signature96.set(publicKeyBytes, 0)
    signature96.set(signature64.data.array, 32)
    return new Signature(KeyType.ED, Bytes.from(signature96))
  }

  /**
   * Create an authex cross-chain link for a WIRE `account` (ETH `EVM` or SOL `SVM`).
   * Invokes `sysio.authex::createlink`, authorized by `account@active`.
   */
  export async function createLink(wire: WireClient, params: LinkParams): Promise<void> {
    const { chainKind, account, privateKey, ethereumWallet } = params,
      publicKey =
        chainKind === ChainKind.EVM && ethereumWallet
          ? ethereumPublicKeyFromWallet(ethereumWallet)
          : privateKey.toPublic(),
      publicKeyString = publicKey.toString(),
      nonce = Date.now(),
      message = buildLinkMessage(publicKeyString, account, chainKind, nonce),
      signature = await (chainKind === ChainKind.EVM && ethereumWallet
        ? signEthereumMessage(message, ethereumWallet)
        : signSolanaMessage(privateKey, message))

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
}
