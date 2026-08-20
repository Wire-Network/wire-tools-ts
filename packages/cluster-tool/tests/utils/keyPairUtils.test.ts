import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { WireKeyType } from "@wireio/opp-typescript-models"
import {
  ethereumCompressedPubkey,
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyFromWallet,
  ethereumPublicKeyFromWallet,
  ethereumSigner,
  ethereumUncompressedPublicKeyHex,
  keyPairFromPrivate,
  privateKeyFromNativeString,
  solanaKeypair,
  solanaNativePublicKey,
  solanaSdkPrivateKey,
  wireKeyFromPublicKey
} from "@wireio/cluster-tool/utils"
import { Constants } from "@wireio/cluster-tool/Constants"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import type { EthereumKeyPair, SolanaKeyPair } from "@wireio/cluster-tool/types"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic = "test test test test test test test test test test test junk"

function anvilWallet(index: number): ethers.HDNodeWallet {
  return ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(AnvilMnemonic), `m/44'/60'/0'/0/${index}`)
}

function solanaFixture(): SolanaKeyPair {
  const priv = PrivateKey.generate(KeyType.ED)
  return {
    type: KeyType.ED,
    publicKey: priv.toPublic().toString(),
    privateKey: priv.toString()
  }
}

/**
 * A BLS key whose base64url payload contains `_` — the shape sdk-core's
 * `PrivateKey.from` mis-splits. ~53% of BLS keys carry one, so a short
 * deterministic search always finds one. The return type is INFERRED — an
 * explicit `PrivateKey` annotation would force sdk-core's cjs + esm declaration
 * flavors into one nominal type (same reason as the round-trip tuple below).
 */
function underscoreBLSPrivateKey() {
  const candidates = Array.from({ length: 64 }, (_unused, index) =>
      PrivateKey.regenerate(KeyType.BLS, new Uint8Array(32).fill(index))
    ),
    found = candidates.find(key => key.toString().slice(8).includes("_"))
  expect(found).toBeDefined()
  return found
}

describe("keyPairUtils", () => {
  describe("privateKeyFromNativeString", () => {
    it("round-trips a BLS key whose base64url payload contains an underscore", () => {
      // `PVT_BLS_` payloads are base64url, an alphabet that INCLUDES `_`, and
      // the publish path parses them on the way to `toNativeString()`. Guards
      // the sdk-core parser this package depends on for every BLS key.
      const original = underscoreBLSPrivateKey(),
        parsed = privateKeyFromNativeString(KeyType.BLS, original.toString())
      expect(parsed.toString()).toBe(original.toString())
      expect(parsed.toNativeString()).toBe(original.toNativeString())
      expect(parsed.toPublic().toString()).toBe(original.toPublic().toString())
      expect(parsed.proofOfPossessionString).toBe(original.proofOfPossessionString)
    })

    it("round-trips every key type through toNativeString (K1 WIF / EM 0x-hex / ED base58 / BLS PVT_BLS_)", () => {
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY),
        em = ethereumPrivateKeyFromWallet(anvilWallet(0)),
        ed = PrivateKey.generate(KeyType.ED),
        bls = PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY)
      // Inferred tuple types — an explicit PrivateKey annotation would force the
      // sdk-core cjs + esm declaration flavors into one nominal type.
      const roundTrips = [
        [KeyType.K1, k1],
        [KeyType.EM, em],
        [KeyType.ED, ed],
        [KeyType.BLS, bls]
      ] as const
      roundTrips.forEach(([type, privateKey]) =>
        expect(privateKeyFromNativeString(type, privateKey.toNativeString()).toString()).toBe(privateKey.toString())
      )
    })

    it("accepts an EM hex value without the 0x prefix", () => {
      const em = ethereumPrivateKeyFromWallet(anvilWallet(1)),
        bareHex = em.toNativeString().slice(2)
      expect(privateKeyFromNativeString(KeyType.EM, bareHex).toString()).toBe(em.toString())
    })

    it("throws on an unsupported key type", () => {
      expect(() => privateKeyFromNativeString(KeyType.R1, "anything")).toThrow(/unsupported key type/)
    })
  })

  describe("keyPairFromPrivate (the D21 adoption seam)", () => {
    it("rebuilds a K1 pair from its WIF (chain-native) string", () => {
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY),
        pair = keyPairFromPrivate(KeyType.K1, k1.toNativeString())
      expect(pair.type).toBe(KeyType.K1)
      expect(pair.privateKey).toBe(k1.toString())
      expect(pair.publicKey).toBe(k1.toPublic().toString())
    })

    it("rebuilds a BLS pair INCLUDING its proof of possession", () => {
      const bls = PrivateKey.from(Constants.DEV_BLS_PRIVATE_KEY),
        pair = keyPairFromPrivate(KeyType.BLS, bls.toNativeString())
      expect(pair.type).toBe(KeyType.BLS)
      expect(pair.privateKey).toBe(Constants.DEV_BLS_PRIVATE_KEY)
      expect(pair.publicKey).toBe(Constants.DEV_BLS_PUBLIC_KEY)
      // Genesis `initial_finalizer_key` + ConsensusSteps.runSetFinalizer read
      // this — an adopted BLS key without it is unusable.
      expect(pair.proofOfPossession).toBe(Constants.DEV_BLS_PROOF_OF_POSSESSION)
    })

    it("rebuilds a BLS pair whose payload carries the sdk-core underscore trap", () => {
      const original = underscoreBLSPrivateKey(),
        pair = keyPairFromPrivate(KeyType.BLS, original.toNativeString())
      expect(pair.privateKey).toBe(original.toString())
      expect(pair.publicKey).toBe(original.toPublic().toString())
      expect(pair.proofOfPossession).toBe(original.proofOfPossessionString)
    })

    it("rebuilds an ED pair from base58 of the 64-byte secret", () => {
      const ed = PrivateKey.generate(KeyType.ED),
        pair = keyPairFromPrivate(KeyType.ED, ed.toNativeString())
      expect(pair.type).toBe(KeyType.ED)
      expect(pair.privateKey).toBe(ed.toString())
      expect(pair.publicKey).toBe(ed.toPublic().toString())
    })

    it("rebuilds an EM pair INCLUDING its 0x address, from the 0x-hex secret", () => {
      const wallet = anvilWallet(7),
        generated = ethereumKeyPairFromWallet(wallet),
        pair = keyPairFromPrivate(KeyType.EM, ethereumPrivateKeyFromWallet(wallet).toNativeString())
      // An ADOPTED pair must be indistinguishable from a generated one.
      expect(pair).toEqual(generated)
      expect(pair.address).toBe(wallet.address)
    })

    it("throws on a curve with no native-string parser", () => {
      expect(() => keyPairFromPrivate(KeyType.R1, "anything")).toThrow(/unsupported key type/)
    })
  })

  // ── live ethers wallet → typed EM keys ──
  describe("ethereumPrivateKeyFromWallet", () => {
    it("derives a PVT_EM_ key deterministically per HD index", () => {
      const key = ethereumPrivateKeyFromWallet(anvilWallet(0))
      expect(key.toString()).toMatch(/^PVT_EM_/)
      expect(ethereumPrivateKeyFromWallet(anvilWallet(0)).toString()).toBe(key.toString())
      expect(ethereumPrivateKeyFromWallet(anvilWallet(1)).toString()).not.toBe(key.toString())
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
      expect(keyPair.publicKey).toBe(ethereumPublicKeyFromWallet(wallet).toString())
      expect(keyPair.privateKey).toBe(ethereumPrivateKeyFromWallet(wallet).toString())
    })
  })

  // ── stored EthereumKeyPair → live objects ──
  describe("ethereumSigner / ethereumCompressedPubkey", () => {
    let provider: ethers.JsonRpcProvider
    beforeAll(async () => {
      // Never dialed — only used to attach the reconstructed Wallet; still resolve
      // a free port per bind-available-ports-not-fixed.
      const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
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

  // ── public-key derivations that survive SSM (refs-only) custody ──
  describe("ethereumUncompressedPublicKeyHex", () => {
    it("matches the value derived from the private key (0x + 128 hex, no 04)", () => {
      const wallet = anvilWallet(4),
        keyPair = ethereumKeyPairFromWallet(wallet),
        fromPrivate = `0x${new ethers.SigningKey(wallet.privateKey).publicKey.slice(4)}`
      expect(ethereumUncompressedPublicKeyHex(keyPair)).toBe(fromPrivate)
      expect(ethereumUncompressedPublicKeyHex(keyPair)).toMatch(/^0x[0-9a-fA-F]{128}$/)
    })

    it("renders from a REFS-ONLY pair (awsSecretId, no privateKey)", () => {
      const wallet = anvilWallet(4),
        generated = ethereumKeyPairFromWallet(wallet),
        refsOnly: EthereumKeyPair = {
          type: KeyType.EM,
          publicKey: generated.publicKey,
          address: generated.address,
          awsSecretId: "/wire/test/batchop.a/EM"
        }
      expect(ethereumUncompressedPublicKeyHex(refsOnly)).toBe(ethereumUncompressedPublicKeyHex(generated))
    })
  })

  describe("solanaNativePublicKey", () => {
    it("is the base58 of the 32-byte pubkey, and renders refs-only", () => {
      const fixture = solanaFixture(),
        refsOnly: SolanaKeyPair = {
          type: KeyType.ED,
          publicKey: fixture.publicKey,
          awsSecretId: "/wire/test/batchop.a/ED"
        }
      expect(solanaNativePublicKey(fixture)).toBe(solanaKeypair(fixture).publicKey.toBase58())
      expect(solanaNativePublicKey(refsOnly)).toBe(solanaNativePublicKey(fixture))
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
      expect(keypair.publicKey.toBase58()).toBe(solanaKeypair(fixture).publicKey.toBase58())
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
      expect(() => wireKeyFromPublicKey({ type: KeyType.WA, compressed: new Uint8Array(33) })).toThrow(
        /not a Wire account-authority key type/
      )
      expect(() => wireKeyFromPublicKey({ type: KeyType.BLS, compressed: new Uint8Array(96) })).toThrow(
        /not a Wire account-authority key type/
      )
    })
  })
})
