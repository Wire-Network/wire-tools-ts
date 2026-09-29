import {
  Bytes,
  KeyType,
  PrivateKey,
  PublicKey,
  Signature
} from "@wireio/sdk-core"

import {
  createFinalizerRegistrationProof,
  finalizerRegistrationMessage
} from "@wireio/cluster-tool/utils/finalizerRegistrationUtils"
import { keyPairFromPrivate } from "@wireio/cluster-tool/utils/keyPairUtils"
import vector from "./finalizerRegistrationVector.js"

describe("account-bound finalizer registration", () => {
  const pair = keyPairFromPrivate(KeyType.BLS, vector.private_key)

  it("matches the C++/contract scalar-one vector exactly", () => {
    expect(pair.publicKey).toBe(vector.public_key)
    expect(
      Bytes.from(finalizerRegistrationMessage(vector.account, pair.publicKey))
        .hexString
    ).toBe(vector.message_hex)
    expect(createFinalizerRegistrationProof(vector.account, pair)).toBe(
      vector.proof
    )
  })

  it("retains the ordinary BIOS PoP and binds the second signature to account and key", () => {
    const proof = createFinalizerRegistrationProof(vector.account, pair),
      [, pop, signature] = proof.split(":"),
      verifier = Signature.from(signature),
      publicKey = PublicKey.from(pair.publicKey),
      otherKey = PrivateKey.generate(KeyType.BLS).toPublic()
    expect(pop).toBe(pair.proofOfPossession)
    expect(
      verifier.verifyMessage(
        finalizerRegistrationMessage(vector.account, pair.publicKey),
        publicKey
      )
    ).toBe(true)
    expect(
      verifier.verifyMessage(
        finalizerRegistrationMessage("bob111111111", pair.publicKey),
        publicKey
      )
    ).toBe(false)
    expect(
      verifier.verifyMessage(
        finalizerRegistrationMessage(vector.account, otherKey.toString()),
        publicKey
      )
    ).toBe(false)
    expect(createFinalizerRegistrationProof("bob111111111", pair)).not.toBe(
      proof
    )
  })

  it.each(["", "alice.", "ALICE", "abcdefghijklz"])(
    "rejects invalid account %s",
    account => {
      expect(() => createFinalizerRegistrationProof(account, pair)).toThrow()
    }
  )

  it("rejects absent private material and mismatched keys", () => {
    expect(() =>
      createFinalizerRegistrationProof(vector.account, {
        ...pair,
        privateKey: undefined
      })
    ).toThrow(/private key material/)
    expect(() =>
      createFinalizerRegistrationProof(vector.account, {
        ...pair,
        publicKey: PrivateKey.generate(KeyType.BLS).toPublic().toString()
      })
    ).toThrow(/mismatch/)
  })

  it("rejects a non-BLS key", () => {
    expect(() =>
      finalizerRegistrationMessage(
        vector.account,
        PrivateKey.generate(KeyType.K1).toPublic().toString()
      )
    ).toThrow(/must be BLS/)
  })
})
