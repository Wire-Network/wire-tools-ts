import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  ethereumCompressedPubkey,
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyFromWallet,
  ethereumPublicKeyFromWallet,
  ethereumSigner,
  solanaKeypair,
  solanaSdkPrivateKey
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
})
