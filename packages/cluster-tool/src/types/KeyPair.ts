import { KeyType } from "@wireio/sdk-core"

/**
 * The curve-agnostic members every {@link KeyPair} carries — the curve tag plus
 * the Wire-canonical key strings.
 */
export interface KeyPairCommon<T extends KeyType = KeyType> {
  readonly type: T
  readonly publicKey: string
  readonly privateKey: string
}

/** The BLS-only {@link KeyPair} extension: the finalizer key's proof of possession. */
export interface KeyPairProofOfPossession {
  readonly proofOfPossession: string
}

/** The EM-only {@link KeyPair} extension: the address derived from the key. */
export interface KeyPairAddress {
  readonly address: string
}

/**
 * The {@link KeyPair} extension for a curve that adds NO members beyond
 * {@link KeyPairCommon} (K1, ED) — deliberately empty.
 */
export interface KeyPairNoExtension {}

/**
 * A key pair tagged with its curve. String members are Wire-canonical
 * (`PUB_<KeyType>_…` / `PVT_<KeyType>_…` / `SIG_BLS_…`) so they round-trip
 * through JSON cluster state. BLS — and only BLS — additionally carries a proof
 * of possession; the conditional makes that compile-enforced. Replaces the
 * duplicated `K1KeyPair` / `BLSKeyPair` interfaces.
 */
export type KeyPair<T extends KeyType = KeyType> = KeyPairCommon<T> &
  (T extends KeyType.BLS
    ? KeyPairProofOfPossession
    : T extends KeyType.EM
      ? KeyPairAddress
      : KeyPairNoExtension)

/** WIRE operator key pair (`PUB_K1_…` / `PVT_K1_…`). */
export type WireKeyPair = KeyPair<KeyType.K1>
/** Finalizer (BLS) key pair (`PUB_BLS_…` / `PVT_BLS_…` + proof of possession). */
export type WireFinalizerKeyPair = KeyPair<KeyType.BLS>
/** Ethereum (secp256k1 / EM) key pair (`PUB_EM_…` / `PVT_EM_…`). */
export type EthereumKeyPair = KeyPair<KeyType.EM>
/** Solana (Ed25519 / ED) key pair (`PUB_ED_…` / `PVT_ED_…`). */
export type SolanaKeyPair = KeyPair<KeyType.ED>
