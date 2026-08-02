import Assert from "node:assert"
import { Name, secureRandom } from "@wireio/sdk-core"

/**
 * The alphabet a sponsor nonce is drawn from — the WIRE `name` symbol set
 * (`.12345abcdefghijklmnopqrstuvwxyz`) MINUS `.`. The dot is dropped
 * deliberately: `Name`'s canonical pattern forbids it in the FINAL position of a
 * 1..12-character name, and `Name.isValid` additionally requires the
 * `nameToString(stringToName(value)) === value` round-trip, which right-trims
 * trailing dots — so a dot-bearing nonce is either invalid outright or can
 * collapse onto another nonce's on-chain name. 31 symbols across 12 characters
 * is ~59 bits, far beyond what per-creator uniqueness needs.
 */
const SponsorNonceAlphabet = "abcdefghijklmnopqrstuvwxyz12345"

/** Character length of a generated sponsor nonce — a WIRE `name`'s full width. */
const SponsorNonceLength = 12

/**
 * Mint a fresh, single-use `sysio.roa::newuser` sponsor nonce.
 *
 * The nonce is the entropy the depot mixes into the generated
 * `<nodeOwner>.<suffix>` account name, and `sysio.roa` hard-rejects a nonce the
 * creator has already used (`"Sponsor entry for this nonce already exists"`) —
 * so it is NEVER an operator's durable handle and is never persisted. Each byte
 * of {@link secureRandom} maps into {@link SponsorNonceAlphabet} by modulo; the
 * resulting ~0.05-bit bias across 31 symbols is immaterial when uniqueness is
 * only required per creator across a few dozen draws.
 *
 * @returns A 12-character `[a-z1-5]` nonce, asserted valid as a WIRE `name`.
 */
export function newSponsorNonce(): string {
  const nonce = Array.from(
    secureRandom(SponsorNonceLength),
    byte => SponsorNonceAlphabet[byte % SponsorNonceAlphabet.length]
  ).join("")
  Assert.ok(
    Name.isValid(nonce),
    `newSponsorNonce: generated nonce "${nonce}" is not a valid WIRE name`
  )
  return nonce
}
