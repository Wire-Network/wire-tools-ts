import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { WireKeyType } from "@wireio/opp-typescript-models"
import {
  ethereumCompressedPubkey,
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyFromWallet,
  ethereumPublicKeyFromWallet,
  ethereumSigner,
  solanaKeypair,
  solanaSdkPrivateKey,
  wireKeyFromPublicKey
} from "@wireio/cluster-tool/utils"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import type { EthereumKeyPair, SolanaKeyPair } from "@wireio/cluster-tool/types"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic =
  "test test test test test test test test test test test junk"

function anvilWallet(index: number): ethers.HDNodeWallet {
  return ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(AnvilMnemonic),
    `m/44'/60'/0'/0/${index}`
  )
}

function solanaFixture(): SolanaKeyPair {
  const priv = PrivateKey.generate(KeyType.ED)
  return {
    type: KeyType.ED,
    publicKey: priv.toPublic().toString(),
    privateKey: priv.toString()
  }
}

describe("keyPairUtils", () => {
  // ── live ethers wallet → typed EM keys ──
  describe("ethereumPrivateKeyFromWallet", () => {
    it("derives a PVT_EM_ key deterministically per HD index", () => {
      const key = ethereumPrivateKeyFromWallet(anvilWallet(0))
      expect(key.toString()).toMatch(/^PVT_EM_/)
      expect(ethereumPrivateKeyFromWallet(anvilWallet(0)).toString()).toBe(
        key.toString()
      )
      expect(ethereumPrivateKeyFromWallet(anvilWallet(1)).toString()).not.toBe(
        key.toString()
      )
    })
  })

  describe("ethereumPublicKeyFromWallet", () => {
    it("yields a PUB_EM_ key matching the one derived from the private key", () => {
      const wallet = anvilWallet(3),
        fromWallet = ethereumPublicKeyFromWallet(wallet).toString(),
        fromPrivate = ethereumPrivateKeyFromWallet(wallet).toPublic().toString()
      expect(fromWallet).toMatch(/^PUB_EM_/)
      expect(fromWallet).toBe(fromPrivate)
    })
  })

  describe("ethereumKeyPairFromWallet", () => {
    it("builds an EthereumKeyPair carrying pub/priv/address from a wallet", () => {
      const wallet = anvilWallet(35),
        keyPair = ethereumKeyPairFromWallet(wallet)
      expect(keyPair.type).toBe(KeyType.EM)
      expect(keyPair.publicKey).toMatch(/^PUB_EM_/)
      expect(keyPair.privateKey).toMatch(/^PVT_EM_/)
      expect(keyPair.address).toBe(wallet.address)
      expect(keyPair.publicKey).toBe(
        ethereumPublicKeyFromWallet(wallet).toString()
      )
      expect(keyPair.privateKey).toBe(
        ethereumPrivateKeyFromWallet(wallet).toString()
      )
    })
  })

  // ── stored EthereumKeyPair → live objects ──
  describe("ethereumSigner / ethereumCompressedPubkey", () => {
    let provider: ethers.JsonRpcProvider
    beforeAll(async () => {
      // Never dialed — only used to attach the reconstructed Wallet; still resolve
      // a free port per bind-available-ports-not-fixed.
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultAnvil
      )
      provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`)
    })

    it("reconstructs a signer whose address matches the stored EM key pair", () => {
      const wallet = anvilWallet(2),
        keyPair: EthereumKeyPair = ethereumKeyPairFromWallet(wallet)
      expect(ethereumSigner(keyPair, provider).address).toBe(wallet.address)
    })

    it("derives the 33-byte compressed secp256k1 public key", () => {
      const keyPair = ethereumKeyPairFromWallet(anvilWallet(2))
      expect(ethereumCompressedPubkey(keyPair).byteLength).toBe(33)
    })
  })

  // ── stored SolanaKeyPair → live objects ──
  describe("solanaSdkPrivateKey / solanaKeypair", () => {
    it("round-trips the sdk-core ED private key", () => {
      const fixture = solanaFixture()
      expect(solanaSdkPrivateKey(fixture).toString()).toBe(fixture.privateKey)
    })

    it("reconstructs a deterministic web3 Keypair (64-byte secret)", () => {
      const fixture = solanaFixture(),
        keypair = solanaKeypair(fixture)
      expect(keypair.publicKey.toBase58()).toBe(
        solanaKeypair(fixture).publicKey.toBase58()
      )
      expect(keypair.secretKey.length).toBe(64)
    })
  })

  // ── Wire public key → OPP proto WireKey ──
  describe("wireKeyFromPublicKey", () => {
    it("maps every account-authority key type to its proto variant with the raw point bytes", () => {
      const cases = [
        { type: KeyType.K1, size: 33, wireKeyType: WireKeyType.K1 },
        { type: KeyType.R1, size: 33, wireKeyType: WireKeyType.R1 },
        { type: KeyType.EM, size: 33, wireKeyType: WireKeyType.EM },
        { type: KeyType.ED, size: 32, wireKeyType: WireKeyType.ED }
      ] as const
      cases.forEach(({ type, size, wireKeyType }) => {
        const compressed = new Uint8Array(size).fill(7),
          wireKey = wireKeyFromPublicKey({ type, compressed })
        expect(wireKey.keyType).toBe(wireKeyType)
        expect(wireKey.key).toEqual(compressed)
      })
    })

    it("parses the PUB_* string form (an anvil wallet's EM key round-trips)", () => {
      const publicKey = ethereumPublicKeyFromWallet(anvilWallet(3)),
        wireKey = wireKeyFromPublicKey(publicKey.toString())
      expect(wireKey.keyType).toBe(WireKeyType.EM)
      expect(wireKey.key).toEqual(publicKey.data.array)
    })

    it("throws for key types unusable as an account authority (WA, BLS)", () => {
      expect(() =>
        wireKeyFromPublicKey({ type: KeyType.WA, compressed: new Uint8Array(33) })
      ).toThrow(/not a Wire account-authority key type/)
      expect(() =>
        wireKeyFromPublicKey({ type: KeyType.BLS, compressed: new Uint8Array(96) })
      ).toThrow(/not a Wire account-authority key type/)
    })
  })
})
