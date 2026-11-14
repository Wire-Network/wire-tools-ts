import { KeyType } from "@wireio/sdk-core"

/**
 * The curve-agnostic members every {@link KeyPair} carries — the curve tag, the
 * Wire-canonical public key, and EXACTLY ONE custody form for the secret.
 *
 * Custody is a real runtime alternative, not an optionality convenience:
 * - `privateKey` — the Wire-canonical key material itself. Present in memory
 *   for every key the run generates OR adopts from SSM / a KEY cluster's own
 *   `cluster-keys.json`, and the persisted form under a `KEY` / `KIOD`
 *   signature provider.
 * - `awsSecretId` — the SSM parameter id the key material lives under. The
 *   persisted form under an `SSM` signature provider, where `cluster-keys.json`
 *   carries NO key material at all (§5.6) and a rehydrated pair is refs-only:
 *   the daemon's `--signature-provider …,SSM:<id>` spec is what fetches the key
 *   at startup, so nothing downstream of `ClusterState.loadKeys` may read
 *   `privateKey`.
 * - `awsKmsKeyId` (+ `awsKmsRegion`, {@link KeyPairKmsCustody} — the K1, EM
 *   and ED curves, which AWS KMS can custody) — the AWS KMS key the secret
 *   lives in and NEVER leaves: the pair carries no `privateKey` even in
 *   memory, every signature is a remote `KMS::Sign`
 *   (`keyPairUtils.wireSigner` / `keyPairUtils.ethereumSigner` /
 *   `keyPairUtils.solanaSigner`), and the daemon's spec is
 *   `…,KMS:<region>:<keyId>`.
 *
 * `ClusterState`'s per-curve schemas enforce the exactly-one rule on the
 * persisted records; in memory the slots are simply absent-able.
 */
export interface KeyPairCommon<T extends KeyType = KeyType> {
  readonly type: T
  readonly publicKey: string
  readonly privateKey?: string
  readonly awsSecretId?: string
}

/** The BLS-only {@link KeyPair} extension: the finalizer key's proof of possession. */
export interface KeyPairProofOfPossession {
  readonly proofOfPossession: string
}

/** The EM-only {@link KeyPair} extension: the `0x` address derived from the key. */
export interface KeyPairAddress {
  readonly address: string
}

/**
 * The {@link KeyPair} extension of the curves AWS KMS can custody (K1, EM, ED
 * — `KMSCustodiedKeyTypes`): the THIRD custody form, an AWS KMS key reference
 * (`awsKmsKeyId` is any `KeyId` KMS accepts, an alias name for
 * harness-rendered keys; `awsKmsRegion` the ONE region it lives in). Both are
 * present or both absent. On a K1 pair it is the batch operators' WIRE
 * account key custody (`keyPairUtils.wireSigner`) — a producer's
 * block-signing K1 never carries one, since nodeop requires that key local.
 */
export interface KeyPairKmsCustody {
  readonly awsKmsKeyId?: string
  readonly awsKmsRegion?: string
}

/**
 * The {@link KeyPair} extension for a curve that adds NO members beyond
 * {@link KeyPairCommon} (R1, WA) — deliberately empty.
 */
export interface KeyPairNoExtension {}

/**
 * A key pair tagged with its curve. String members are Wire-canonical
 * (`PUB_<KeyType>_…` / `PVT_<KeyType>_…` / `SIG_BLS_…`) so they round-trip
 * through JSON cluster state. BLS — and only BLS — additionally carries a proof
 * of possession; EM carries its address; K1, EM and ED may carry a KMS key
 * reference — the conditional makes each compile-enforced. Replaces the
 * duplicated `K1KeyPair` / `BLSKeyPair` interfaces.
 */
export type KeyPair<T extends KeyType = KeyType> = KeyPairCommon<T> &
  (T extends KeyType.BLS
    ? KeyPairProofOfPossession
    : T extends KeyType.EM
      ? KeyPairAddress & KeyPairKmsCustody
      : T extends KeyType.K1 | KeyType.ED
        ? KeyPairKmsCustody
        : KeyPairNoExtension)

/** WIRE operator key pair (`PUB_K1_…` / `PVT_K1_…`, or a KMS key reference for a batch operator's account key). */
export type WireKeyPair = KeyPair<KeyType.K1>
/** Finalizer (BLS) key pair (`PUB_BLS_…` / `PVT_BLS_…` + proof of possession). */
export type WireFinalizerKeyPair = KeyPair<KeyType.BLS>
/** Ethereum (secp256k1 / EM) key pair (`PUB_EM_…` / `PVT_EM_…`). */
export type EthereumKeyPair = KeyPair<KeyType.EM>
/** Public Ethereum identity paired with its normalized, prefix-free EVM address. */
export interface EthereumIdentity extends Pick<EthereumKeyPair, "publicKey"> {
  readonly nativeAddress: string
}
/** Solana (Ed25519 / ED) key pair (`PUB_ED_…` / `PVT_ED_…`). */
export type SolanaKeyPair = KeyPair<KeyType.ED>

/**
 * The per-curve key members a SIGNING IDENTITY carries.
 *
 * ONE shape for both identity kinds: `ClusterKeyStore.ProducerKeySet` (a node's
 * `wire` + `wireFinalizer`) and `OperatorAccount` (an operator's `wire` plus
 * whichever outpost curves it is bonded on) are both structurally assignable,
 * so ONE resolver and ONE publication walker cover every identity that renders
 * a `--signature-provider` spec.
 *
 * They were previously two shapes with two vocabularies (`{k1, bls}` vs
 * `{wire, wireFinalizer}`), which is what let the bios identity fall between
 * them — stored as an operator, published as a node, and therefore published by
 * neither walker.
 */
export interface SigningKeySet {
  /** WIRE block-signing key — every identity has one. */
  readonly wire: WireKeyPair
  /** WIRE finality key — nodes and the genesis identity; absent on batch/underwriter operators. */
  readonly wireFinalizer?: WireFinalizerKeyPair
  /** Ethereum key — operators bonded on the ETH outpost. */
  readonly ethereum?: EthereumKeyPair
  /** Solana key — operators bonded on the SOL outpost. */
  readonly solana?: SolanaKeyPair
}
