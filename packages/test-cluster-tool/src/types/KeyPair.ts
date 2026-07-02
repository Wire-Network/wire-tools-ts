import { KeyType } from "@wireio/sdk-core"

/**
 * A key pair tagged with its curve. String members are Wire-canonical
 * (`PUB_<KeyType>_…` / `PVT_<KeyType>_…` / `SIG_BLS_…`) so they round-trip
 * through JSON cluster state. BLS — and only BLS — additionally carries a proof
 * of possession; the conditional makes that compile-enforced. Replaces the
 * duplicated `K1KeyPair` / `BLSKeyPair` interfaces.
 */
export type KeyPair<T extends KeyType = KeyType> = {
  readonly type: T
  readonly publicKey: string
  readonly privateKey: string
} & (T extends KeyType.BLS ? { readonly proofOfPossession: string } : T extends KeyType.EM ? {
  readonly address: string
} : {})

/** WIRE operator key pair (`PUB_K1_…` / `PVT_K1_…`). */
export type WireKeyPair = KeyPair<KeyType.K1>
/** Finalizer (BLS) key pair (`PUB_BLS_…` / `PVT_BLS_…` + proof of possession). */
export type WireFinalizerKeyPair = KeyPair<KeyType.BLS>
/** Ethereum (secp256k1 / EM) key pair (`PUB_EM_…` / `PVT_EM_…`). */
export type EthereumKeyPair = KeyPair<KeyType.EM>
/** Solana (Ed25519 / ED) key pair (`PUB_ED_…` / `PVT_ED_…`). */
export type SolanaKeyPair = KeyPair<KeyType.ED>
