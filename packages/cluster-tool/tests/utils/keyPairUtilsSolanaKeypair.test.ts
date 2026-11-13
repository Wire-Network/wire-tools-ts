import { Keypair } from "@solana/web3.js"
import { KeyType } from "@wireio/sdk-core"
import {
  solanaKeyPairFromKeypair,
  solanaKeypair,
  solanaNativePublicKey
} from "@wireio/cluster-tool/utils"

describe("keyPairUtils.solanaKeyPairFromKeypair", () => {
  it("builds the stored ED pair whose public half is the keypair's own key", () => {
    const keypair = Keypair.generate(),
      pair = solanaKeyPairFromKeypair(keypair)
    expect(pair.type).toBe(KeyType.ED)
    expect(pair.publicKey).toMatch(/^PUB_ED_/)
    expect(pair.privateKey).toMatch(/^PVT_ED_/)
    expect(solanaNativePublicKey(pair)).toBe(keypair.publicKey.toBase58())
  })

  it("is the exact inverse of solanaKeypair — the secret round-trips byte for byte", () => {
    const keypair = Keypair.generate(),
      restored = solanaKeypair(solanaKeyPairFromKeypair(keypair))
    expect(Buffer.from(restored.secretKey)).toEqual(Buffer.from(keypair.secretKey))
    expect(restored.publicKey.equals(keypair.publicKey)).toBe(true)
  })

  it("derives distinct pairs for distinct keypairs — nothing is shared or seeded", () => {
    const first = solanaKeyPairFromKeypair(Keypair.generate()),
      second = solanaKeyPairFromKeypair(Keypair.generate())
    expect(first.publicKey).not.toBe(second.publicKey)
    expect(first.privateKey).not.toBe(second.privateKey)
  })
})
