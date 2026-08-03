/** One key-material signature — what it detects, and the detector itself. */
export interface KeyMaterialPattern {
  /** What the pattern detects (quoted verbatim in a scanner's failure message). */
  readonly name: string
  /**
   * The detector. Every length-windowed entry is fenced with lookarounds over
   * the WHOLE alphanumeric/base64url set, so a run that merely happens to fit
   * the window INSIDE a longer key or id token cannot satisfy it — real secrets
   * are delimited by JSON punctuation or whitespace.
   */
  readonly pattern: RegExp
}

/**
 * THE key-material signature set — every textual shape a private key, secret,
 * or seed takes in a persisted WIRE artifact. It exists so a "this file carries
 * no plaintext" claim is PROVEN mechanically rather than spot-checked: scan the
 * serialized text with {@link findKeyMaterial} and assert the result is empty
 * (an SSM-mode `cluster-keys.json`, an emitted `external-cluster-config.json`,
 * a `cluster-state.json`).
 *
 * NEVER re-spell this list at a call site — import it. A new secret encoding
 * gets a new entry HERE, and every scanner picks it up in the same change.
 */
export const KeyMaterialPatterns: readonly KeyMaterialPattern[] = [
  {
    // `PVT_K1_…` / `PVT_EM_…` / `PVT_ED_…` (base58) and `PVT_BLS_…` (base64url),
    // i.e. every WIRE-canonical private key `PrivateKey.toString()` emits.
    name: "WIRE canonical private key (PVT_<type>_…)",
    pattern: /PVT_[A-Z0-9]+_[0-9A-Za-z_-]+/
  },
  {
    // K1's chain-NATIVE form: base58check of 0x80 ‖ 32 bytes ‖ 4-byte checksum
    // — always 51 chars, always `5H` / `5J` / `5K`. Fenced by TokenBoundary so
    // a coincidental run inside a longer key/id token cannot satisfy it.
    name: "wallet import format (WIF) private key",
    pattern:
      /(?<![0-9A-Za-z_+/=-])5[HJK][1-9A-HJ-NP-Za-km-z]{49}(?![0-9A-Za-z_+/=-])/
  },
  {
    // EM's chain-native form. A `0x` address is 40 hex chars, so the exact-64
    // window plus the hex lookarounds keeps addresses out.
    name: "0x-prefixed 32-byte hex private key",
    pattern: /(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/
  },
  {
    // ED's chain-native form: base58 of the 64-byte libsodium secret — 87 or 88
    // characters. Fenced by TokenBoundary (NOT merely by non-base58) so a run
    // that happens to avoid base58's excluded letters INSIDE a longer base64url
    // token — a `PUB_BLS_…` key or a `SIG_BLS_…` proof of possession — cannot
    // satisfy the window. A real ED secret is delimited by JSON punctuation.
    name: "base58 64-byte ed25519 secret key",
    pattern:
      /(?<![0-9A-Za-z_+/=-])[1-9A-HJ-NP-Za-km-z]{87,88}(?![0-9A-Za-z_+/=-])/
  },
  {
    // The `solana-keygen` keypair file shape — a JSON array of exactly 64 bytes.
    name: "64-element JSON byte-array secret key",
    pattern: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/
  },
  {
    // A BIP-39 seed phrase: 12 words, or 12 followed by 12 more.
    name: "BIP-39 mnemonic phrase (12 or 24 words)",
    pattern: /\b[a-z]{3,8}(?: [a-z]{3,8}){11}(?:(?: [a-z]{3,8}){12})?\b/
  }
] as const

/**
 * Every {@link KeyMaterialPatterns} entry that matches `text`. An empty result
 * is the proof that `text` carries no secret.
 *
 * @param text - The serialized artifact to scan.
 * @returns The matching signatures (empty when the text is plaintext-free).
 */
export function findKeyMaterial(text: string): KeyMaterialPattern[] {
  return KeyMaterialPatterns.filter(entry => entry.pattern.test(text))
}
