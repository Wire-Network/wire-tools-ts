import { ethers } from "ethers"
import { KeyType, PrivateKey, PublicKey } from "@wireio/sdk-core"

/** The relying-party id {@link fixtureWebAuthnPublicKey} carries. */
const FixtureRelyingPartyId = "wire.network"
/** A WebAuthn key's user-presence byte: presence required. */
const UserPresenceRequired = 1

/**
 * A WebAuthn public key: a random R1 point, the user-presence byte, then the
 * relying-party id behind its length.
 *
 * @returns The key, as sdk-core parses a `PUB_WA_` string.
 */
export function fixtureWebAuthnPublicKey(): PublicKey {
  const relyingPartyId = Buffer.from(FixtureRelyingPartyId)
  return PublicKey.from({
    type: KeyType.WA,
    compressed: Buffer.concat([
      PrivateKey.generate(KeyType.R1).toPublic().data.array,
      Buffer.from([UserPresenceRequired, relyingPartyId.length]),
      relyingPartyId
    ])
  })
}

/**
 * Every `PUB_EM_` spelling libfc parses for one secp256k1 point, as `it.each` rows.
 *
 * @param key - A key holding the point compressed (`K1` or `EM`).
 * @returns `[label, spelling]` per spelling: compressed, uncompressed with and
 *   without its `04` marker, and `0x`-prefixed.
 */
export function fixtureEthereumPublicKeySpellings(
  key: PublicKey
): Array<[string, string]> {
  const compressed = ethers.hexlify(key.data.array).slice(2),
    uncompressed = ethers.SigningKey.computePublicKey(key.data.array, false).slice(2)
  return [
    ["compressed", `PUB_EM_${compressed}`],
    ["uncompressed with its marker", `PUB_EM_${uncompressed}`],
    ["uncompressed without its marker", `PUB_EM_${uncompressed.slice(2)}`],
    ["0x-prefixed", `PUB_EM_0x${uncompressed}`]
  ]
}
