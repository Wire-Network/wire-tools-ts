import { ethers } from "ethers"
import {
  getCompressedPublicKey,
  KeyType,
  PublicKey,
  PrivateKey
} from "@wireio/sdk-core"
import {
  emPrivateKeyFromEthWallet,
  emPublicKeyFromEthWallet
} from "../src/tools/AuthExLinkTool.js"

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
const DERIVATION_PATH = "m/44'/60'/0'/0/"

function walletAtIndex(index: number): ethers.HDNodeWallet {
  const mnemonic = ethers.Mnemonic.fromPhrase(ANVIL_MNEMONIC)
  return ethers.HDNodeWallet.fromMnemonic(mnemonic, `${DERIVATION_PATH}${index}`)
}

function rawCompressedPrefix(wallet: ethers.HDNodeWallet): number {
  const compressed = getCompressedPublicKey(wallet.signingKey.publicKey)
  const hex = compressed.startsWith("0x") ? compressed.slice(2) : compressed
  return parseInt(hex.slice(0, 2), 16)
}

describe("AuthExLinkTool", () => {
  // Anvil index 1 has 0x02 prefix, index 2 has 0x03 prefix
  const wallet02 = walletAtIndex(1)
  const wallet03 = walletAtIndex(2)

  describe("key prefix detection", () => {
    it("anvil index 1 has 0x02 compressed prefix", () => {
      expect(rawCompressedPrefix(wallet02)).toBe(0x02)
    })

    it("anvil index 2 has 0x03 compressed prefix", () => {
      expect(rawCompressedPrefix(wallet03)).toBe(0x03)
    })
  })

  describe("emPublicKeyFromEthWallet", () => {
    it("forces 0x02 prefix for 0x02 key (no-op)", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet02)
      const str = pubKey.toString()
      expect(str).toMatch(/^PUB_EM_02/)
    })

    it("forces 0x02 prefix for 0x03 key", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet03)
      const str = pubKey.toString()
      expect(str).toMatch(/^PUB_EM_02/)
    })

    it("preserves x-coordinate regardless of prefix", () => {
      const pub02 = emPublicKeyFromEthWallet(wallet02).toString()
      const pub03 = emPublicKeyFromEthWallet(wallet03).toString()

      // Both have PUB_EM_02 prefix, but different x-coordinates (different keys)
      expect(pub02.slice(0, 9)).toBe("PUB_EM_02")
      expect(pub03.slice(0, 9)).toBe("PUB_EM_02")
      // x-coordinates differ (different wallets)
      expect(pub02.slice(9)).not.toBe(pub03.slice(9))
    })

    it("produces 33-byte key (prefix + 32-byte x)", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet03)
      const str = pubKey.toString()
      // PUB_EM_ (7 chars) + 66 hex chars (33 bytes)
      expect(str.length).toBe(7 + 66)
    })
  })

  describe("emPrivateKeyFromEthWallet", () => {
    it("derives EM private key from wallet", () => {
      const privKey = emPrivateKeyFromEthWallet(wallet02)
      const pubKey = privKey.toPublic()
      expect(pubKey.toString()).toMatch(/^PUB_EM_/)
    })

    it("different wallets produce different private keys", () => {
      const priv02 = emPrivateKeyFromEthWallet(wallet02)
      const priv03 = emPrivateKeyFromEthWallet(wallet03)
      expect(priv02.toString()).not.toBe(priv03.toString())
    })

    it("private key round-trips to public key for both prefixes", () => {
      [wallet02, wallet03].forEach(wallet => {
        const privKey = emPrivateKeyFromEthWallet(wallet)
        const pubKey = privKey.toPublic()
        expect(pubKey.toString()).toMatch(/^PUB_EM_/)
        // Public key should be 33 bytes (66 hex chars after PUB_EM_)
        expect(pubKey.toString().length).toBe(7 + 66)
      })
    })
  })

  describe("message string format", () => {
    it("PUB_EM_ string is lowercase hex", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet03)
      const hex = pubKey.toString().slice(7) // strip PUB_EM_
      expect(hex).toMatch(/^[0-9a-f]+$/)
    })

    it("message format matches contract expectation", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet02)
      const account = "batchop.a"
      const chainKind = 2
      const nonce = 1234567890
      const msg = `${pubKey.toString()}|${account}|${chainKind}|${nonce}|createlink auth`

      expect(msg).toMatch(/^PUB_EM_02[0-9a-f]{64}\|batchop\.a\|2\|1234567890\|createlink auth$/)
    })
  })
})
