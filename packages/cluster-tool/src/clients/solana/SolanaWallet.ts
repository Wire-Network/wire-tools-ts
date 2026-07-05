import { Keypair, PublicKey } from "@solana/web3.js"

/** The harness's signing wrapper for the Solana outpost. */
export class SolanaWallet {
  constructor(readonly keypair: Keypair) {}

  /** The wallet's public key. */
  get publicKey(): PublicKey {
    return this.keypair.publicKey
  }

  /** Build a wallet from a raw secret key. */
  static fromSecretKey(secret: Uint8Array): SolanaWallet {
    return new SolanaWallet(Keypair.fromSecretKey(secret))
  }
}
