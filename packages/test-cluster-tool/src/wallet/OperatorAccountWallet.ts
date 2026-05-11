import type { PrivateKey, PublicKey, Signature } from "@wireio/sdk-core"
import type { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import type { BytesType } from "@wireio/sdk-core"

/**
 * Signing identity for a bootstrapped operator on a single outpost / depot
 * chain.
 *
 * Each cluster operator (batch op / underwriter / …) holds one
 * `OperatorAccountWallet` per chain it participates on — WIRE (K1), the
 * Ethereum outpost (EM / secp256k1), the Solana outpost (ED / Ed25519).
 * The same WIRE account name appears in every chain's wallet for that
 * operator; only the curve / address / sign path differs.
 *
 * Implementations live alongside this file
 * (`{Ethereum,Solana,Wire}OperatorAccountWallet.ts`) and are dispatched
 * by `chain` — call sites either consume them via the interface only or
 * narrow with `instanceof` when they need chain-specific surface (e.g.
 * the embedded `ethers.HDNodeWallet` for ETH tx sends, the
 * `@solana/web3.js` `Keypair` for SOL tx sends, …).
 *
 * Signing goes through `@wireio/sdk-core`'s `PrivateKey.signMessage`,
 * which handles ECDSA (K1 / R1 / EM — hash-then-sign with SHA-256) and
 * raw EdDSA / BLS (ED / BLS — sign the message bytes directly) in a
 * single uniform call. That matches how the harness's own bootstrap
 * signs across chains and avoids a per-chain re-implementation here.
 */
export interface OperatorAccountWallet {
  /** WIRE account name this operator is registered as (e.g. `batchop.a`). */
  readonly name: string
  /** Which chain this wallet signs for. Discriminator for `instanceof` narrowing. */
  readonly chain: ChainKind
  /** Operator role registered in `sysio.opreg::operators` (BATCH / UNDERWRITER / …). */
  readonly operatorType: OperatorType
  /**
   * Public key, wrapped in Wire's chain-agnostic `PublicKey` so callers
   * can `toString()` it (PUB_K1_* / PUB_EM_* / PUB_ED_*) or read its raw
   * bytes via `data.array`.
   */
  readonly publicKey: PublicKey
  /**
   * Private key, wrapped in Wire's `PrivateKey`. Use `.signMessage(...)`
   * for chain-correct signing; the underlying byte material is available
   * via `data.array` for libraries that demand raw seeds.
   */
  readonly privateKey: PrivateKey
  /**
   * Chain-native address string, when one exists distinct from `name`:
   * 0x-prefixed 20-byte ETH address, base58 SOL pubkey, etc. For WIRE
   * the operator's identity *is* the account name; concrete impls may
   * omit this or return `name`.
   */
  readonly address?: string
  /**
   * Sign an arbitrary message under this wallet's private key. Returns a
   * chain-tagged `Signature` (`SIG_K1_*` / `SIG_EM_*` / `SIG_ED_*`) — for
   * ECDSA chains the message is SHA-256-hashed first; for ED / BLS it's
   * signed raw. Mirrors `PrivateKey.signMessage` from `@wireio/sdk-core`.
   */
  sign(message: BytesType): Signature
}
