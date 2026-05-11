import { Keypair } from "@solana/web3.js"
import {
  type BytesType,
  PrivateKey,
  PublicKey,
  Signature
} from "@wireio/sdk-core"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import type { OperatorAccountWallet } from "./OperatorAccountWallet.js"

/**
 * Solana-side signing identity for a bootstrapped operator.
 *
 * Backed by an ED25519 keypair created at cluster bootstrap
 * (`PrivateKey.generate(KeyType.ED)` in `ClusterManager`). The private
 * material is persisted on `NodeState.keys.solEd` so attach-mode flow
 * tests can rebuild this wallet exactly as the bootstrap saw it.
 *
 * `sign(message)` delegates to sdk-core's `PrivateKey.signMessage` —
 * for ED25519 that signs the raw bytes (no SHA-256 prefix). Call sites
 * that need to submit actual Solana transactions can narrow to this
 * concrete class and use `solKeypair` with `@solana/web3.js`'s
 * `sendTransaction` / `signTransaction` API.
 *
 * `address` returns the base58-encoded 32-byte Ed25519 pubkey — the
 * canonical Solana account identifier.
 */
export class SolanaOperatorAccountWallet implements OperatorAccountWallet {
  readonly chain: ChainKind = ChainKind.SOLANA

  /**
   * @param name         WIRE account name registered in `sysio.opreg`.
   * @param operatorType Role (BATCH / UNDERWRITER / …).
   * @param publicKey    32-byte Ed25519 pubkey, wrapped as `PUB_ED_*`.
   *                     Matches the operator's `sysio.authex::links`
   *                     entry for the Solana chain.
   * @param privateKey   ED25519 64-byte signing key (seed + pubkey),
   *                     wrapped as `PVT_ED_*`.
   * @param solKeypair   `@solana/web3.js` Keypair for submitting native
   *                     Solana transactions. Optional in case a caller
   *                     wants signing-only without taking the
   *                     `@solana/web3.js` dependency in their flow.
   */
  constructor(
    readonly name: string,
    readonly operatorType: OperatorType,
    readonly publicKey: PublicKey,
    readonly privateKey: PrivateKey,
    readonly solKeypair: Keypair
  ) {}

  /** Base58 Ed25519 pubkey — the Solana account identifier. */
  get address(): string {
    return this.solKeypair.publicKey.toBase58()
  }

  /** sdk-core uniform signing — Ed25519 raw signature over `message` → `SIG_ED_*`. */
  sign(message: BytesType): Signature {
    return this.privateKey.signMessage(message)
  }
}

export namespace SolanaOperatorAccountWallet {
  /**
   * Build a Solana wallet from a sdk-core `PrivateKey` (ED). Derives the
   * matching `@solana/web3.js` `Keypair` from the private bytes so call
   * sites that need the native Solana SDK can read it directly.
   */
  export function fromSdkPrivateKey(args: {
    name: string
    operatorType: OperatorType
    privateKey: PrivateKey
  }): SolanaOperatorAccountWallet {
    const { name, operatorType, privateKey } = args
    const publicKey = privateKey.toPublic()
    // sdk-core's ED25519 private material is 64 bytes (seed || pubkey) —
    // the exact layout `Keypair.fromSecretKey` expects.
    const solKeypair = Keypair.fromSecretKey(privateKey.data.array)
    return new SolanaOperatorAccountWallet(
      name,
      operatorType,
      publicKey,
      privateKey,
      solKeypair
    )
  }
}
