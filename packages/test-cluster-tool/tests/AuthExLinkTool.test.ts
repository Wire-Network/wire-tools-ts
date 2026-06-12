import { ethers } from "ethers"
import {
  Bytes,
  getCompressedPublicKey,
  KeyType,
  PublicKey,
  PrivateKey,
  Signature
} from "@wireio/sdk-core"
import {
  createAuthExLink,
  emPrivateKeyFromEthWallet,
  emPublicKeyFromEthWallet
} from "@wireio/test-cluster-tool"
import { freshEthPubEm } from "@wireio/test-cluster-tool/tools/AuthExLinkTool"
import { ChainKind } from "@wireio/opp-typescript-models"
import type { Clio } from "@wireio/test-cluster-tool/clients/Clio"

const ANVIL_MNEMONIC =
  "test test test test test test test test test test test junk"
const DERIVATION_PATH = "m/44'/60'/0'/0/"

function walletAtIndex(index: number): ethers.HDNodeWallet {
  const mnemonic = ethers.Mnemonic.fromPhrase(ANVIL_MNEMONIC)
  return ethers.HDNodeWallet.fromMnemonic(
    mnemonic,
    `${DERIVATION_PATH}${index}`
  )
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
    it("preserves 0x02 prefix for 0x02 key", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet02)
      const str = pubKey.toString()
      expect(str).toMatch(/^PUB_EM_02/)
    })

    it("preserves 0x03 prefix for 0x03 key", () => {
      const pubKey = emPublicKeyFromEthWallet(wallet03)
      const str = pubKey.toString()
      expect(str).toMatch(/^PUB_EM_03/)
    })

    it("preserves x-coordinate and real prefix", () => {
      const pub02 = emPublicKeyFromEthWallet(wallet02).toString()
      const pub03 = emPublicKeyFromEthWallet(wallet03).toString()

      expect(pub02.slice(0, 9)).toBe("PUB_EM_02")
      expect(pub03.slice(0, 9)).toBe("PUB_EM_03")
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
      ;[wallet02, wallet03].forEach(wallet => {
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

      expect(msg).toMatch(
        /^PUB_EM_02[0-9a-f]{64}\|batchop\.a\|2\|1234567890\|createlink auth$/
      )
    })
  })

  describe("freshEthPubEm", () => {
    it("returns a PUB_EM_ secp256k1 public key string", () => {
      const key = freshEthPubEm()
      expect(typeof key).toBe("string")
      // PUB_EM_ + 0x02/0x03 prefix byte + 32-byte X coordinate = 66 hex chars.
      expect(key).toMatch(/^PUB_EM_0[23][0-9a-f]{64}$/)
    })

    it("returns a different key on each call (random wallet)", () => {
      expect(freshEthPubEm()).not.toBe(freshEthPubEm())
    })
  })

  describe("createAuthExLink SVM signature payload", () => {
    it("signs the hex-encoded mapped digest (wire-sysio 030c32f8e5 convention)", async () => {
      const edKey = PrivateKey.generate(KeyType.ED)
      const pushActionAndWait = jest.fn().mockResolvedValue(undefined)
      const clio = { pushActionAndWait } as unknown as Clio

      await createAuthExLink(clio, {
        chainKind: ChainKind.SVM,
        account: "freshop",
        // The tests project resolves sdk-core's ESM typings while the src
        // declarations pin the CJS flavor — same runtime class, nominally
        // twinned types. Bridge like the chainKind cast in AuthExLinkTool.
        privateKey: edKey as unknown as Parameters<
          typeof createAuthExLink
        >[1]["privateKey"]
      })

      expect(pushActionAndWait).toHaveBeenCalledWith(
        "sysio.authex",
        "createlink",
        expect.objectContaining({ account: "freshop" }),
        "freshop@active"
      )
      const payload = pushActionAndWait.mock.calls[0][2]

      // Recompute the contract-side digest: sha256(msg) mapped to ASCII
      // [33..126], then hex-encoded — the payload the chain's ed25519
      // recovery verifies against since wire-sysio 030c32f8e5.
      const message = `${payload.pub_key}|freshop|${ChainKind.SVM}|${payload.nonce}|createlink auth`
      const mapped = Uint8Array.from(
        ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(message))),
        b => 33 + (b % 94)
      )
      const mappedHex = ethers.hexlify(mapped).slice(2)

      // ED25519 signing is deterministic: re-signing the hex payload with
      // the same key must reproduce the 64-byte signature embedded at
      // bytes [32..96] of the 96-byte wire signature.
      const expected64 = edKey.signMessage(
        Bytes.from(ethers.toUtf8Bytes(mappedHex))
      ).data.array
      const sig = Signature.from(payload.sig)
      const sigBytes = sig.data.array
      expect(sigBytes.length).toBe(96)
      expect(Buffer.from(sigBytes.slice(0, 32))).toEqual(
        Buffer.from(edKey.toPublic().data.array)
      )
      expect(Buffer.from(sigBytes.slice(32))).toEqual(Buffer.from(expected64))
    })
  })
})
