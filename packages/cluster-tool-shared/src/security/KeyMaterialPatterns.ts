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
    pattern: /(?<![0-9A-Za-z_+/=-])5[HJK][1-9A-HJ-NP-Za-km-z]{49}(?![0-9A-Za-z_+/=-])/
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
    pattern: /(?<![0-9A-Za-z_+/=-])[1-9A-HJ-NP-Za-km-z]{87,88}(?![0-9A-Za-z_+/=-])/
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

/** What a scrubbed `--signature-provider` spec's key is replaced with. */
export const RedactedKeyMarker = "<redacted>"

/**
 * The signature set for scanning FREE-FORM LOGS, where {@link KeyMaterialPatterns}
 * is unsound.
 *
 * A log is mostly hashes, and a 32-byte hex string is a private key or a block
 * hash by shape alone — nothing distinguishes them. Measured on one real
 * cluster-create log: 1049 hits for the naked-hex entry, of which **800 were
 * `Block Hash:`, 162 `Transaction:`, 50 anvil's published dev constants, and ~37
 * substrings of 128-hex PUBLIC keys. Zero were secret.** A gate at that
 * signal-to-noise ratio reports nothing usable.
 *
 * In a log a real secret only ever appears as the key half of a
 * `--signature-provider` spec, so THAT is what is matched — and it catches every
 * encoding the spec carries (`PVT_K1_…`, `PVT_BLS_…`, `0x…` for EM, bare base58
 * for ED: 19 of 19 on the same log, where matching the scheme token plus `0x`
 * alone caught 5).
 *
 * The marker exclusion is load-bearing: the collector rewrites secrets to the
 * scheme token followed by `${RedactedKeyMarker}`, so a pattern without it flags
 * its own output — 19 hits on a log whose every secret was successfully removed.
 *
 * NOTE: this doc block deliberately does NOT spell the scheme token literally —
 * see {@link SchemeToken}. The bundled server ships this file's source inside
 * its sourcemap, so a literal here is a permanent self-match.
 *
 * This set is for LOGS only. {@link KeyMaterialPatterns} remains the gate for
 * persisted artifacts, where a bare `PVT_…` with no spec around it is exactly
 * the shape that must never ship.
 */
/**
 * The signature-provider scheme token, assembled at RUNTIME.
 *
 * This detector is bundled verbatim into `wire-debugging-server.cjs` (and its
 * sourcemap), so spelling the token as a literal makes the scanner flag its own
 * shipped bundle — a permanent CI warning that also blocks ever re-arming the
 * gate as fail-closed. Concatenation does NOT help: esbuild constant-folds
 * `"KE" + "Y:"` back to the literal even at `minify: false`. A runtime `join`
 * survives, and costs one array allocation at module load.
 */
const SchemeToken = ["KE", "Y:"].join("")

export const KeySpecPatterns: readonly KeyMaterialPattern[] = [
  {
    name: `unredacted --signature-provider key (${SchemeToken}<private>)`,
    pattern: new RegExp(`${SchemeToken}(?!${RedactedKeyMarker})[^,"\\s]+`)
  }
] as const

/**
 * Every entry of `patterns` that matches `text`. An empty result is the proof
 * that `text` carries no secret of the kinds that set describes.
 *
 * @param text - The serialized artifact to scan.
 * @param patterns - The signature set (defaults to the persisted-artifact set;
 *   pass {@link KeySpecPatterns} for free-form logs).
 * @returns The matching signatures (empty when the text is plaintext-free).
 */
export function findKeyMaterial(
  text: string,
  patterns: readonly KeyMaterialPattern[] = KeyMaterialPatterns
): KeyMaterialPattern[] {
  return patterns.filter(entry => entry.pattern.test(text))
}
