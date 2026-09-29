import Assert from "node:assert"

import {
  KeyType,
  Name,
  PrivateKey,
  PublicKey,
  Serializer
} from "@wireio/sdk-core"

import type { WireFinalizerKeyPair } from "../types/KeyPair.js"

/** Wire format shared with sysio.system and sys-util; changing it requires a new version. */
export namespace FinalizerRegistration {
  /** Selects the two-signature envelope; changes require a new protocol version. */
  export const ProofPrefix = "REG_BLS_V1:"
  /** Separates registration from other ordinary BLS signatures; changes invalidate proofs. */
  export const MessageDomain = "WIRE:sysio.system:regfinkey:v1"
  /** Size of a canonical affine little-endian BLS G1 key, excluding prefix and checksum. */
  export const PublicKeySize = 96
}

/**
 * Encode domain ASCII, account uint64 LE, and canonical affine LE BLS public key.
 * No NUL terminator, lengths, or prehash are added.
 * @param account - The registering on-chain account.
 * @param publicKey - Its BLS finalizer public key.
 * @returns The raw message signed for regfinkey.
 */
export function finalizerRegistrationMessage(
  account: string,
  publicKey: string
): Uint8Array {
  const name = Name.from(account),
    key = PublicKey.from(publicKey)
  Assert.ok(account.length > 0, "finalizer account must not be empty")
  Assert.equal(key.type, KeyType.BLS, "finalizer key must be BLS")
  Assert.equal(key.data.array.length, FinalizerRegistration.PublicKeySize)
  return Buffer.concat([
    Buffer.from(FinalizerRegistration.MessageDomain, "ascii"),
    Serializer.encode({ object: name }).array,
    key.data.array
  ])
}

/**
 * Preserve the standard PoP and add the account-bound signature required by regfinkey.
 * Called during provisioning, while private material is available, before persisted SSM
 * key records strip it. BIOS continues to use the stored ordinary proofOfPossession.
 * @param account - The registering on-chain account.
 * @param pair - The account's BLS key material.
 * @returns The versioned two-signature registration proof.
 */
export function createFinalizerRegistrationProof(
  account: string,
  pair: WireFinalizerKeyPair
): string {
  Assert.ok(
    pair.privateKey,
    "finalizer registration requires private key material"
  )
  const key = PrivateKey.from(pair.privateKey)
  Assert.equal(key.type, KeyType.BLS, "finalizer key must be BLS")
  Assert.equal(
    key.toPublic().toString(),
    pair.publicKey,
    "finalizer public/private key mismatch"
  )
  const message = finalizerRegistrationMessage(account, pair.publicKey)
  return `${FinalizerRegistration.ProofPrefix}${key.proofOfPossessionString}:${key.signMessage(message)}`
}
