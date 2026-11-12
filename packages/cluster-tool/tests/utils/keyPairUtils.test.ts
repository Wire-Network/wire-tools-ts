import { ethers } from "ethers"
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js"
import nacl from "tweetnacl"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { WireKeyType } from "@wireio/opp-typescript-models"
import {
  ethereumCompressedPubkey,
  ethereumKeyPairFromKmsPublicKey,
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyFromWallet,
  ethereumPrivateKeyHex,
  ethereumPublicKeyFromWallet,
  ethereumSdkPrivateKey,
  ethereumSigner,
  ethereumUncompressedPublicKeyHex,
  isKmsCustodied,
  keyPairFromPrivate,
  privateKeyFromNativeString,
  solanaKeyPairFromKmsPublicKey,
  solanaKeypair,
  solanaNativePublicKey,
  solanaPublicKey,
  solanaSdkPrivateKey,
  solanaSigner,
  solanaSignerFromKeypair,
  wireKeyFromPublicKey
} from "@wireio/cluster-tool/utils"
import { Constants } from "@wireio/cluster-tool/Constants"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { KMSClientProvider } from "@wireio/cluster-tool/config/KMSClientProvider"
import type {
  EthereumKeyPair,
  SolanaKeyPair,
  SolanaSigner
} from "@wireio/cluster-tool/types"

/** A fresh random ethers wallet — the only kind the harness ever holds. */
function randomWallet(): ethers.HDNodeWallet {
  return ethers.Wallet.createRandom()
}

/** The ONE region a KMS key lives in, and the alias the harness renders for it. */
const KmsRegion = "us-east-1"
const KmsAliasName = "alias/wire/test/batchop-a/EM"
/** The alias the harness renders for the same operator's ED key. */
const SolanaKmsAliasName = "alias/wire/test/batchop-a/ED"

/** A KMS-custodied ED pair whose public identity is `fixture`'s — no material. */
function solanaKmsPairOf(fixture: SolanaKeyPair): SolanaKeyPair {
  return solanaKeyPairFromKmsPublicKey(
    solanaKeypair(fixture).publicKey.toBytes(),
    KmsRegion,
    SolanaKmsAliasName
  )
}

/** The compressed secp256k1 point KMS reports for `wallet` (via `GetPublicKey`). */
function compressedPointOf(wallet: ethers.HDNodeWallet): Uint8Array {
  return ethers.getBytes(
    ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
  )
}

/** A KMS-custodied EM pair whose public identity is `wallet`'s — no material. */
function kmsPairOf(wallet: ethers.HDNodeWallet): EthereumKeyPair {
  return ethereumKeyPairFromKmsPublicKey(
    compressedPointOf(wallet),
    KmsRegion,
    KmsAliasName
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
      expect(parsed.proofOfPossessionString).toBe(
        original.proofOfPossessionString
      )
    })

    it("round-trips every key type through toNativeString (K1 WIF / EM 0x-hex / ED base58 / BLS PVT_BLS_)", () => {
      const k1 = PrivateKey.from(Constants.DEV_K1_PRIVATE_KEY),
        em = ethereumPrivateKeyFromWallet(randomWallet()),
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
        expect(
          privateKeyFromNativeString(type, privateKey.toNativeString()).toString()
        ).toBe(privateKey.toString())
      )
    })

    it("accepts an EM hex value without the 0x prefix", () => {
      const em = ethereumPrivateKeyFromWallet(randomWallet()),
        bareHex = em.toNativeString().slice(2)
      expect(privateKeyFromNativeString(KeyType.EM, bareHex).toString()).toBe(
        em.toString()
      )
    })

    it("throws on an unsupported key type", () => {
      expect(() => privateKeyFromNativeString(KeyType.R1, "anything")).toThrow(
        /unsupported key type/
      )
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
      const wallet = randomWallet(),
        generated = ethereumKeyPairFromWallet(wallet),
        pair = keyPairFromPrivate(
          KeyType.EM,
          ethereumPrivateKeyFromWallet(wallet).toNativeString()
        )
      // An ADOPTED pair must be indistinguishable from a generated one.
      expect(pair).toEqual(generated)
      expect(pair.address).toBe(wallet.address)
    })

    it("throws on a curve with no native-string parser", () => {
      expect(() => keyPairFromPrivate(KeyType.R1, "anything")).toThrow(
        /unsupported key type/
      )
    })
  })

  // ── live ethers wallet → typed EM keys ──
  describe("ethereumPrivateKeyFromWallet", () => {
    it("derives the SAME PVT_EM_ key from one wallet, and a different one from another", () => {
      const wallet = randomWallet(),
        key = ethereumPrivateKeyFromWallet(wallet)
      expect(key.toString()).toMatch(/^PVT_EM_/)
      expect(ethereumPrivateKeyFromWallet(wallet).toString()).toBe(
        key.toString()
      )
      expect(ethereumPrivateKeyFromWallet(randomWallet()).toString()).not.toBe(
        key.toString()
      )
    })
  })

  describe("ethereumPublicKeyFromWallet", () => {
    it("yields a PUB_EM_ key matching the one derived from the private key", () => {
      const wallet = randomWallet(),
        fromWallet = ethereumPublicKeyFromWallet(wallet).toString(),
        fromPrivate = ethereumPrivateKeyFromWallet(wallet).toPublic().toString()
      expect(fromWallet).toMatch(/^PUB_EM_/)
      expect(fromWallet).toBe(fromPrivate)
    })
  })

  describe("ethereumKeyPairFromWallet", () => {
    it("builds an EthereumKeyPair carrying pub/priv/address from a wallet", () => {
      const wallet = randomWallet(),
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

    it("reconstructs a LOCAL signer — an ethers.Wallet on the provider — whose address matches the stored EM key pair", async () => {
      const wallet = randomWallet(),
        keyPair: EthereumKeyPair = ethereumKeyPairFromWallet(wallet),
        signer = await ethereumSigner(keyPair, provider)
      expect(signer).toBeInstanceOf(ethers.Wallet)
      expect(signer.provider).toBe(provider)
      await expect(signer.getAddress()).resolves.toBe(wallet.address)
    })

    it("without a provider, still signs offline — the same signature as the source wallet", async () => {
      const wallet = randomWallet(),
        signer = await ethereumSigner(ethereumKeyPairFromWallet(wallet))
      expect(signer.provider).toBeNull()
      expect(await signer.signMessage("createlink")).toBe(
        await wallet.signMessage("createlink")
      )
    })

    it("ethereumPrivateKeyHex is the 0x-hex secret the source wallet was built from", () => {
      const wallet = randomWallet()
      expect(ethereumPrivateKeyHex(ethereumKeyPairFromWallet(wallet))).toBe(
        wallet.privateKey
      )
    })

    it("derives the 33-byte compressed secp256k1 public key", () => {
      const keyPair = ethereumKeyPairFromWallet(randomWallet())
      expect(ethereumCompressedPubkey(keyPair).byteLength).toBe(33)
    })
  })

  // ── the KMS custody form: a key reference, never material ──
  describe("isKmsCustodied", () => {
    it("is true for a pair carrying a KMS key reference, false for material and SSM refs", () => {
      const wallet = randomWallet(),
        generated = ethereumKeyPairFromWallet(wallet),
        ssmRefsOnly: EthereumKeyPair = {
          type: KeyType.EM,
          publicKey: generated.publicKey,
          address: generated.address,
          awsSecretId: "/wire/test/batchop.a/EM"
        }
      expect(isKmsCustodied(kmsPairOf(wallet))).toBe(true)
      expect(isKmsCustodied(generated)).toBe(false)
      expect(isKmsCustodied(ssmRefsOnly)).toBe(false)
    })
  })

  describe("ethereumKeyPairFromKmsPublicKey", () => {
    it("builds the pair's PUBLIC identity from the compressed point — PUB_EM_, the checksummed address, the key ref, and NO privateKey", () => {
      const wallet = randomWallet(),
        pair = kmsPairOf(wallet)
      expect(pair.type).toBe(KeyType.EM)
      expect(pair.publicKey).toMatch(/^PUB_EM_/)
      // The same PUB_EM_ a local wallet derives — the point IS the identity.
      expect(pair.publicKey).toBe(ethereumPublicKeyFromWallet(wallet).toString())
      expect(pair.address).toBe(wallet.address)
      expect(pair.address).toBe(
        ethers.computeAddress(ethers.hexlify(compressedPointOf(wallet)))
      )
      expect(pair.awsKmsRegion).toBe(KmsRegion)
      expect(pair.awsKmsKeyId).toBe(KmsAliasName)
      expect(pair).not.toHaveProperty("privateKey")
      expect(pair).not.toHaveProperty("awsSecretId")
    })
  })

  describe("ethereumSigner (KMS arm) + the material derivations on a KMS pair", () => {
    afterEach(() => jest.restoreAllMocks())

    it("signs through KMSClientProvider.createSigner with the pair's region + key id and the provider", async () => {
      const wallet = randomWallet(),
        pair = kmsPairOf(wallet),
        provider = new ethers.JsonRpcProvider(),
        kmsSigner = new ethers.VoidSigner(wallet.address, provider),
        createSigner = jest
          .spyOn(KMSClientProvider, "createSigner")
          .mockResolvedValue(kmsSigner)
      try {
        await expect(ethereumSigner(pair, provider)).resolves.toBe(kmsSigner)
        expect(createSigner).toHaveBeenCalledTimes(1)
        expect(createSigner).toHaveBeenCalledWith(
          KmsRegion,
          KmsAliasName,
          provider
        )
      } finally {
        provider.destroy()
      }
    })

    it("forwards an ABSENT provider to the KMS arm (offline signing)", async () => {
      const createSigner = jest
        .spyOn(KMSClientProvider, "createSigner")
        .mockResolvedValue(new ethers.VoidSigner(randomWallet().address))
      await ethereumSigner(kmsPairOf(randomWallet()))
      expect(createSigner).toHaveBeenCalledWith(
        KmsRegion,
        KmsAliasName,
        undefined
      )
    })

    it("ethereumPrivateKeyHex / ethereumSdkPrivateKey THROW naming the KMS custody — the secret never leaves KMS", () => {
      const pair = kmsPairOf(randomWallet())
      expect(() => ethereumPrivateKeyHex(pair)).toThrow(
        new RegExp(
          `${pair.address} carries no key material \\(it is custodied by AWS KMS ${KmsAliasName}\\)`
        )
      )
      expect(() => ethereumSdkPrivateKey(pair)).toThrow(
        /custodied by AWS KMS .* — sign through ethereumSigner instead/
      )
    })

    it("names the SSM reference (not KMS) for a refs-only SSM pair that lacks material", () => {
      const generated = ethereumKeyPairFromWallet(randomWallet()),
        ssmRefsOnly: EthereumKeyPair = {
          type: KeyType.EM,
          publicKey: generated.publicKey,
          address: generated.address,
          awsSecretId: "/wire/test/batchop.a/EM"
        }
      expect(() => ethereumPrivateKeyHex(ssmRefsOnly)).toThrow(
        /it is referenced by \/wire\/test\/batchop\.a\/EM/
      )
    })

    it("ethereumCompressedPubkey + ethereumUncompressedPublicKeyHex render from the STORED public key of a KMS pair", () => {
      const wallet = randomWallet(),
        pair = kmsPairOf(wallet)
      expect(ethereumCompressedPubkey(pair)).toEqual(compressedPointOf(wallet))
      expect(ethereumUncompressedPublicKeyHex(pair)).toBe(
        ethereumUncompressedPublicKeyHex(ethereumKeyPairFromWallet(wallet))
      )
    })
  })

  // ── public-key derivations that survive SSM (refs-only) custody ──
  describe("ethereumUncompressedPublicKeyHex", () => {
    it("matches the value derived from the private key (0x + 128 hex, no 04)", () => {
      const wallet = randomWallet(),
        keyPair = ethereumKeyPairFromWallet(wallet),
        fromPrivate = `0x${new ethers.SigningKey(wallet.privateKey).publicKey.slice(4)}`
      expect(ethereumUncompressedPublicKeyHex(keyPair)).toBe(fromPrivate)
      expect(ethereumUncompressedPublicKeyHex(keyPair)).toMatch(
        /^0x[0-9a-fA-F]{128}$/
      )
    })

    it("renders from a REFS-ONLY pair (awsSecretId, no privateKey)", () => {
      const wallet = randomWallet(),
        generated = ethereumKeyPairFromWallet(wallet),
        refsOnly: EthereumKeyPair = {
          type: KeyType.EM,
          publicKey: generated.publicKey,
          address: generated.address,
          awsSecretId: "/wire/test/batchop.a/EM"
        }
      expect(ethereumUncompressedPublicKeyHex(refsOnly)).toBe(
        ethereumUncompressedPublicKeyHex(generated)
      )
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
      expect(solanaNativePublicKey(fixture)).toBe(
        solanaKeypair(fixture).publicKey.toBase58()
      )
      expect(solanaNativePublicKey(refsOnly)).toBe(
        solanaNativePublicKey(fixture)
      )
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

    it("THROW naming the custody for a material-less pair — KMS, or an SSM ref", () => {
      const fixture = solanaFixture(),
        kmsPair = solanaKmsPairOf(fixture),
        ssmRefsOnly: SolanaKeyPair = {
          type: KeyType.ED,
          publicKey: fixture.publicKey,
          awsSecretId: "/wire/test/batchop.a/ED"
        }
      expect(() => solanaSdkPrivateKey(kmsPair)).toThrow(
        new RegExp(
          `the ED key ${fixture.publicKey} carries no key material \\(it is custodied by AWS KMS ${SolanaKmsAliasName}\\) — sign through solanaSigner instead`
        )
      )
      expect(() => solanaKeypair(kmsPair)).toThrow(/custodied by AWS KMS/)
      expect(() => solanaKeypair(ssmRefsOnly)).toThrow(
        /it is referenced by \/wire\/test\/batchop\.a\/ED/
      )
    })
  })

  describe("solanaPublicKey", () => {
    it("is the web3 PublicKey of the STORED key — equal to the keypair's, and rendering for a refs-only / KMS pair", () => {
      const fixture = solanaFixture(),
        expected = solanaKeypair(fixture).publicKey.toBase58()
      expect(solanaPublicKey(fixture).toBase58()).toBe(expected)
      expect(solanaPublicKey(solanaKmsPairOf(fixture)).toBase58()).toBe(expected)
      expect(
        solanaPublicKey({
          type: KeyType.ED,
          publicKey: fixture.publicKey,
          awsSecretId: "/wire/test/batchop.a/ED"
        }).toBase58()
      ).toBe(expected)
    })
  })

  // ── the KMS custody form of an ED pair ──
  describe("solanaKeyPairFromKmsPublicKey / isKmsCustodied (ED)", () => {
    it("builds the pair's PUBLIC identity from the 32-byte point — PUB_ED_, the key ref, and NO privateKey", () => {
      const fixture = solanaFixture(),
        pair = solanaKmsPairOf(fixture)
      expect(pair.type).toBe(KeyType.ED)
      // The same PUB_ED_ the local key derives — the point IS the identity.
      expect(pair.publicKey).toBe(fixture.publicKey)
      expect(pair.awsKmsRegion).toBe(KmsRegion)
      expect(pair.awsKmsKeyId).toBe(SolanaKmsAliasName)
      expect(pair).not.toHaveProperty("privateKey")
      expect(pair).not.toHaveProperty("awsSecretId")
      expect(isKmsCustodied(pair)).toBe(true)
      expect(isKmsCustodied(fixture)).toBe(false)
    })

    it("rejects a point that is not 32 bytes", () => {
      expect(() =>
        solanaKeyPairFromKmsPublicKey(new Uint8Array(33), KmsRegion, SolanaKmsAliasName)
      ).toThrow()
    })
  })

  describe("solanaSignerFromKeypair (the local-custody signer)", () => {
    it("carries the keypair's public key and signs raw messages with pure Ed25519 — the keypair's own detached signature", async () => {
      const keypair = Keypair.generate(),
        signer = solanaSignerFromKeypair(keypair),
        message = new TextEncoder().encode("createlink auth")
      expect(signer.publicKey.toBase58()).toBe(keypair.publicKey.toBase58())
      const signature = await signer.signMessage(message)
      expect(signature).toHaveLength(nacl.sign.signatureLength)
      expect(signature).toEqual(nacl.sign.detached(message, keypair.secretKey))
      expect(
        nacl.sign.detached.verify(message, signature, keypair.publicKey.toBytes())
      ).toBe(true)
    })

    it("signs a prepared transaction as Anchor's wallet does (partialSign), and signAllTransactions each one", async () => {
      const keypair = Keypair.generate(),
        signer = solanaSignerFromKeypair(keypair),
        prepared = () => {
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: keypair.publicKey,
              lamports: 1
            })
          )
          transaction.feePayer = keypair.publicKey
          transaction.recentBlockhash = Keypair.generate().publicKey.toBase58()
          return transaction
        },
        one = await signer.signTransaction(prepared()),
        many = await signer.signAllTransactions([prepared(), prepared()])
      expect(one.verifySignatures()).toBe(true)
      many.forEach(transaction => expect(transaction.verifySignatures()).toBe(true))
      // An unprepared transaction cannot be signed — the caller sets payer + blockhash.
      await expect(signer.signTransaction(new Transaction())).rejects.toThrow()
    })
  })

  describe("solanaSigner (THE facade over both custody forms)", () => {
    afterEach(() => jest.restoreAllMocks())

    it("local material → a keypair-backed signer for the stored pair", async () => {
      const fixture = solanaFixture(),
        signer = await solanaSigner(fixture),
        message = Uint8Array.of(1, 2, 3)
      expect(signer.publicKey.toBase58()).toBe(solanaPublicKey(fixture).toBase58())
      expect(await signer.signMessage(message)).toEqual(
        nacl.sign.detached(message, solanaKeypair(fixture).secretKey)
      )
    })

    it("KMS reference → KMSClientProvider.createSolanaSigner with the pair's region, key id and 32-byte point", async () => {
      const fixture = solanaFixture(),
        pair = solanaKmsPairOf(fixture),
        kmsSigner = { publicKey: solanaPublicKey(fixture) } as unknown as SolanaSigner,
        createSolanaSigner = jest
          .spyOn(KMSClientProvider, "createSolanaSigner")
          .mockResolvedValue(kmsSigner)
      await expect(solanaSigner(pair)).resolves.toBe(kmsSigner)
      expect(createSolanaSigner).toHaveBeenCalledTimes(1)
      expect(createSolanaSigner).toHaveBeenCalledWith(
        KmsRegion,
        SolanaKmsAliasName,
        solanaKeypair(fixture).publicKey.toBytes()
      )
    })

    it("a refs-only SSM pair (no material, no KMS ref) fails naming the SSM reference", async () => {
      await expect(
        solanaSigner({
          type: KeyType.ED,
          publicKey: solanaFixture().publicKey,
          awsSecretId: "/wire/test/batchop.a/ED"
        })
      ).rejects.toThrow(/it is referenced by \/wire\/test\/batchop\.a\/ED/)
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

    it("parses the PUB_* string form (a random wallet's EM key round-trips)", () => {
      const publicKey = ethereumPublicKeyFromWallet(randomWallet()),
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
