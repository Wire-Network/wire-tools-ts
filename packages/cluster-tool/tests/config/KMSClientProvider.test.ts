import { ethers } from "ethers"
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"
import nacl from "tweetnacl"
import { KeyType } from "@wireio/sdk-core"
import { KMSClientProvider } from "@wireio/cluster-tool/config/KMSClientProvider"

const mockSend = jest.fn()
// `mock`-prefixed so jest's factory hoisting allows the reference — holding the
// constructor here guarantees it is the SAME jest.fn the provider's lazy
// `import("@aws-sdk/client-kms")` receives (the SSMClientProvider suite's pattern).
const mockKMSClient = jest.fn().mockImplementation(() => ({ send: mockSend }))
// The SDK's own enum rosters, read from the REAL module AFTER the mock consts
// exist — a static import would hoist the mock factory above them.
const {
  KeySpec,
  KeyUsageType,
  MessageType,
  SigningAlgorithmSpec
}: typeof import("@aws-sdk/client-kms") = jest.requireActual("@aws-sdk/client-kms")
jest.mock("@aws-sdk/client-kms", () => ({
  // The SDK's own enum rosters (`KeySpec`, `KeyUsageType`, `MessageType`,
  // `SigningAlgorithmSpec`) — the provider reads its members off the module.
  ...jest.requireActual("@aws-sdk/client-kms"),
  KMSClient: mockKMSClient,
  GetPublicKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetPublicKey", input })),
  CreateKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateKey", input })),
  CreateAliasCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateAlias", input })),
  SignCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "Sign", input }))
}))

/** The ethers-over-KMS signer, doubled: records what it was constructed with. */
const mockAwsKmsSigner = jest
  .fn()
  .mockImplementation((config: unknown, provider: unknown) => ({
    config,
    provider
  }))
jest.mock("@cuonghx.gu-tech/ethers-aws-kms-signer", () => ({
  AwsKmsSigner: mockAwsKmsSigner
}))

/** One captured command: its kind + the input its constructor received. */
interface SentCommand {
  kind: string
  input: Record<string, unknown>
}

/** Every command sent so far, in order. */
function sentCommands(): SentCommand[] {
  return mockSend.mock.calls.map(([command]: [SentCommand]) => command)
}

/** The client config `KMSClient` was constructed with for `region`. */
interface KMSClientConfig {
  region?: string
  retryMode?: string
  maxAttempts?: number
}

/** Every `KMSClient` construction for `region`. */
function clientConstructionsFor(region: string): KMSClientConfig[] {
  return mockKMSClient.mock.calls
    .map(([config]: [KMSClientConfig]) => config)
    .filter(config => config?.region === region)
}

/** An AWS SDK service exception — identified by its `name`, as the SDK does. */
function kmsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

/**
 * The DER `SubjectPublicKeyInfo` prefix of a secp256k1 public key — the
 * algorithm identifier + BIT STRING header KMS wraps the uncompressed point in.
 */
const Secp256k1SpkiPrefix = "3056301006072a8648ce3d020106052b8104000a034200"

/** A real DER SPKI around `wallet`'s uncompressed public point — what KMS returns. */
function spkiFor(wallet: ethers.HDNodeWallet): Uint8Array {
  return ethers.getBytes(
    `0x${Secp256k1SpkiPrefix}${wallet.signingKey.publicKey.slice(2)}`
  )
}

/** The compressed point ethers derives for `wallet` — the oracle every SPKI decode is held to. */
function compressedFor(wallet: ethers.HDNodeWallet): Uint8Array {
  return ethers.getBytes(
    ethers.SigningKey.computePublicKey(wallet.signingKey.publicKey, true)
  )
}

/** The DER SPKI KMS returns for an Ed25519 key — the RFC 8410 header + the 32-byte point. */
function ed25519SpkiFor(keypair: Keypair): Uint8Array {
  return Uint8Array.of(
    ...KMSClientProvider.Ed25519SpkiPrefix,
    ...keypair.publicKey.toBytes()
  )
}

/** A `GetPublicKey` response for a secp256k1 signing key. */
function publicKeyResponse(
  wallet: ethers.HDNodeWallet,
  keyArn: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    KeyId: keyArn,
    PublicKey: spkiFor(wallet),
    KeySpec: KeySpec.ECC_SECG_P256K1,
    KeyUsage: KeyUsageType.SIGN_VERIFY,
    ...over
  }
}

/** A `GetPublicKey` response for an Ed25519 signing key. */
function ed25519PublicKeyResponse(
  keypair: Keypair,
  keyArn: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    KeyId: keyArn,
    PublicKey: ed25519SpkiFor(keypair),
    KeySpec: KeySpec.ECC_NIST_EDWARDS25519,
    KeyUsage: KeyUsageType.SIGN_VERIFY,
    ...over
  }
}

/** A `Sign` response carrying `keypair`'s real detached signature of `message`. */
function signResponse(keypair: Keypair, message: Uint8Array): Record<string, unknown> {
  return { Signature: nacl.sign.detached(message, keypair.secretKey) }
}

/**
 * RFC 8410 section 10.1's example SubjectPublicKeyInfo — the known-answer
 * vector nodeop's `spki_der_to_ed25519_public_key` test decodes too.
 */
const Rfc8410ExampleSpki = Uint8Array.of(
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, 0x19,
  0xbf, 0x44, 0x09, 0x69, 0x84, 0xcd, 0xfe, 0x85, 0x41, 0xba, 0xc1, 0x67, 0xdc,
  0x3b, 0x96, 0xc8, 0x50, 0x86, 0xaa, 0x30, 0xb6, 0xb6, 0xcb, 0x0c, 0x5c, 0x38,
  0xad, 0x70, 0x31, 0x66, 0xe1
)

const Region = "us-east-1"
const AliasName = "alias/wire/dev/batchop-a/EM"
const SolanaAliasName = "alias/wire/dev/batchop-a/ED"
const KeyArn =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"

/** A legacy transaction whose fee payer + blockhash are set, as `submit` sets them. */
function preparedTransaction(payer: PublicKey): Transaction {
  const transaction = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })
  )
  transaction.feePayer = payer
  transaction.recentBlockhash = Keypair.generate().publicKey.toBase58()
  return transaction
}

/** A v0 transaction with the same single transfer. */
function preparedVersionedTransaction(payer: PublicKey): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })
      ]
    }).compileToV0Message()
  )
}

describe("KMSClientProvider (jest module mock — no live AWS)", () => {
  beforeEach(() => {
    mockSend.mockReset()
    mockAwsKmsSigner.mockClear()
  })

  describe("aliasAccountSegment", () => {
    it("maps a WIRE handle's dots to dashes — the one character KMS forbids in an alias", () => {
      expect(KMSClientProvider.aliasAccountSegment("batchop.a")).toBe("batchop-a")
      expect(KMSClientProvider.aliasAccountSegment("a.b.c")).toBe("a-b-c")
    })

    it("leaves a dot-less handle unchanged (the mapping is injective — WIRE names carry no dash)", () => {
      expect(KMSClientProvider.aliasAccountSegment("node_00")).toBe("node_00")
      expect(KMSClientProvider.aliasAccountSegment("batchopaaaa")).toBe(
        "batchopaaaa"
      )
    })
  })

  describe("assertAliasName", () => {
    it("accepts a harness-rendered alias and returns it", () => {
      expect(KMSClientProvider.assertAliasName(AliasName)).toBe(AliasName)
      expect(
        KMSClientProvider.assertAliasName("alias/wire/prod/node_00/EM_v2")
      ).toBe("alias/wire/prod/node_00/EM_v2")
    })

    it("rejects a dotted alias — the unmapped WIRE handle", () => {
      expect(() =>
        KMSClientProvider.assertAliasName("alias/wire/dev/batchop.a/EM")
      ).toThrow(/is not a KMS alias name/)
    })

    it("rejects an alias missing the alias/ prefix, and an empty tail", () => {
      expect(() =>
        KMSClientProvider.assertAliasName("wire/dev/batchop-a/EM")
      ).toThrow(/must start with alias\//)
      expect(() => KMSClientProvider.assertAliasName("alias/")).toThrow(
        /is not a KMS alias name/
      )
    })
  })

  describe("compressedPointFromSpki", () => {
    it("compresses the uncompressed point a DER SPKI ends with — exactly ethers' compression", () => {
      const wallet = ethers.Wallet.createRandom(),
        compressed = KMSClientProvider.compressedPointFromSpki(spkiFor(wallet))
      expect(compressed).toHaveLength(KMSClientProvider.CompressedPointLength)
      expect(compressed).toEqual(compressedFor(wallet))
      // The compressed point IS the key's identity: it derives the same address.
      expect(ethers.computeAddress(ethers.hexlify(compressed))).toBe(
        wallet.address
      )
    })

    it("rejects a buffer too short to carry an uncompressed point", () => {
      expect(() =>
        KMSClientProvider.compressedPointFromSpki(new Uint8Array(10))
      ).toThrow(/too short to carry an uncompressed secp256k1 point/)
    })

    it("rejects a trailing point whose marker byte is not 0x04", () => {
      const spki = spkiFor(ethers.Wallet.createRandom())
      spki[spki.length - KMSClientProvider.UncompressedPointLength] = 0x02
      expect(() => KMSClientProvider.compressedPointFromSpki(spki)).toThrow(
        /does not end with an uncompressed secp256k1 point \(marker 0x2\)/
      )
    })
  })

  describe("ed25519PublicKeyFromSpki", () => {
    it("decodes RFC 8410 section 10.1's example SPKI to its 32-byte key (the known-answer vector)", () => {
      expect(Rfc8410ExampleSpki).toHaveLength(KMSClientProvider.Ed25519SpkiLength)
      expect(KMSClientProvider.ed25519PublicKeyFromSpki(Rfc8410ExampleSpki)).toEqual(
        Rfc8410ExampleSpki.slice(KMSClientProvider.Ed25519SpkiPrefix.length)
      )
    })

    it("decodes a KMS-shaped SPKI to the keypair's own point — whose base58 IS the Solana key", () => {
      const keypair = Keypair.generate(),
        decoded = KMSClientProvider.ed25519PublicKeyFromSpki(ed25519SpkiFor(keypair))
      expect(decoded).toHaveLength(KMSClientProvider.Ed25519PublicKeyLength)
      expect(new PublicKey(decoded).toBase58()).toBe(keypair.publicKey.toBase58())
    })

    it("rejects a secp256k1 SPKI — the wrong length is the first thing it sees", () => {
      expect(() =>
        KMSClientProvider.ed25519PublicKeyFromSpki(spkiFor(ethers.Wallet.createRandom()))
      ).toThrow(/is not an Ed25519 SubjectPublicKeyInfo \(44 bytes\)/)
    })

    it("rejects a 44-byte SPKI whose AlgorithmIdentifier is not bare id-Ed25519", () => {
      const withParameters = ed25519SpkiFor(Keypair.generate())
      // A NULL parameter where RFC 8410 forbids any: the header no longer matches.
      withParameters[3] = 0x07
      withParameters[9] = 0x05
      expect(() => KMSClientProvider.ed25519PublicKeyFromSpki(withParameters)).toThrow(
        /does not carry id-Ed25519 \(1\.3\.101\.112\) with no parameters/
      )
    })

    it("rejects a key of another length", () => {
      const shortKey = Uint8Array.of(
        ...KMSClientProvider.Ed25519SpkiPrefix,
        ...Keypair.generate().publicKey.toBytes().slice(1)
      )
      expect(() => KMSClientProvider.ed25519PublicKeyFromSpki(shortKey)).toThrow(
        /SPKI of 43 bytes is not an Ed25519 SubjectPublicKeyInfo/
      )
    })
  })

  describe("getPublicKey", () => {
    it("returns the key ARN + compressed point of a secp256k1 SIGN_VERIFY key for an EM key", async () => {
      const wallet = ethers.Wallet.createRandom()
      mockSend.mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
      const publicKey = await KMSClientProvider.getPublicKey(
        Region,
        AliasName,
        KeyType.EM
      )
      expect(publicKey).toEqual({
        keyArn: KeyArn,
        keyType: KeyType.EM,
        publicKey: compressedFor(wallet)
      })
      expect(sentCommands()).toEqual([
        { kind: "GetPublicKey", input: { KeyId: AliasName } }
      ])
    })

    it("returns the key ARN + 32-byte point of an Ed25519 SIGN_VERIFY key for an ED key", async () => {
      const keypair = Keypair.generate()
      mockSend.mockResolvedValueOnce(ed25519PublicKeyResponse(keypair, KeyArn))
      await expect(
        KMSClientProvider.getPublicKey(Region, SolanaAliasName, KeyType.ED)
      ).resolves.toEqual({
        keyArn: KeyArn,
        keyType: KeyType.ED,
        publicKey: keypair.publicKey.toBytes()
      })
    })

    it("rejects a key of another spec — an RSA key cannot sign for ethereum", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeySpec: KeySpec.RSA_2048
        })
      )
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/is a RSA_2048 key, not ECC_SECG_P256K1/)
    })

    it("rejects the OTHER custodied curve's spec — an Ed25519 key cannot sign for ethereum, nor a secp256k1 key for solana", async () => {
      mockSend.mockResolvedValueOnce(ed25519PublicKeyResponse(Keypair.generate(), KeyArn))
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/is a ECC_NIST_EDWARDS25519 key, not ECC_SECG_P256K1/)
      mockSend.mockResolvedValueOnce(publicKeyResponse(ethers.Wallet.createRandom(), KeyArn))
      await expect(
        KMSClientProvider.getPublicKey(Region, SolanaAliasName, KeyType.ED)
      ).rejects.toThrow(/is a ECC_SECG_P256K1 key, not ECC_NIST_EDWARDS25519/)
    })

    it("rejects a key whose usage is not SIGN_VERIFY", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeyUsage: KeyUsageType.ENCRYPT_DECRYPT
        })
      )
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/is a ENCRYPT_DECRYPT key, not SIGN_VERIFY/)
    })

    it("rejects a response carrying no public key", async () => {
      mockSend.mockResolvedValueOnce({ KeyId: KeyArn })
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/returned no public key/)
    })

    it("requires a region — a KMS key is regional", async () => {
      await expect(
        KMSClientProvider.getPublicKey("", AliasName, KeyType.EM)
      ).rejects.toThrow(/a KMS key is regional — region is required/)
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe("tryGetPublicKey (the adopt probe)", () => {
    it("returns the public identity when the alias resolves — for either curve", async () => {
      const wallet = ethers.Wallet.createRandom(),
        keypair = Keypair.generate()
      mockSend
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
        .mockResolvedValueOnce(ed25519PublicKeyResponse(keypair, KeyArn))
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName, KeyType.EM)
      ).resolves.toEqual({
        keyArn: KeyArn,
        keyType: KeyType.EM,
        publicKey: compressedFor(wallet)
      })
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, SolanaAliasName, KeyType.ED)
      ).resolves.toEqual({
        keyArn: KeyArn,
        keyType: KeyType.ED,
        publicKey: keypair.publicKey.toBytes()
      })
    })

    it("returns nothing on NotFoundException — matched BY NAME, the alias simply does not exist", async () => {
      mockSend.mockRejectedValueOnce(
        kmsError("NotFoundException", `Alias ${AliasName} is not found.`)
      )
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName, KeyType.EM)
      ).resolves.toBeNull()
    })

    it("RETHROWS every other failure — AccessDenied is not 'nothing to adopt'", async () => {
      mockSend.mockRejectedValueOnce(
        kmsError(
          "AccessDeniedException",
          "not authorized to perform kms:GetPublicKey"
        )
      )
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/not authorized/)
    })

    it("RETHROWS a wrong-spec key rather than minting a replacement for it", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeySpec: KeySpec.ECC_NIST_P256
        })
      )
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName, KeyType.EM)
      ).rejects.toThrow(/not ECC_SECG_P256K1/)
    })
  })

  describe("createKey", () => {
    /** Answer CreateKey → CreateAlias → GetPublicKey for `wallet`'s key. */
    function answerCreation(wallet: ethers.HDNodeWallet): void {
      mockSend
        .mockResolvedValueOnce({ KeyMetadata: { Arn: KeyArn } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
    }

    it("creates a secp256k1 SIGN_VERIFY key for an EM key, binds the alias to its ARN, then reads the key back through the alias", async () => {
      const wallet = ethers.Wallet.createRandom()
      answerCreation(wallet)
      const created = await KMSClientProvider.createKey(
        Region,
        AliasName,
        KeyType.EM,
        "batch operator batchop.a — ethereum outpost key (EM)"
      )
      expect(created).toEqual({
        keyArn: KeyArn,
        keyType: KeyType.EM,
        publicKey: compressedFor(wallet)
      })
      expect(sentCommands()).toEqual([
        {
          kind: "CreateKey",
          input: {
            KeySpec: KeySpec.ECC_SECG_P256K1,
            KeyUsage: KeyUsageType.SIGN_VERIFY,
            Description: "batch operator batchop.a — ethereum outpost key (EM)"
          }
        },
        {
          kind: "CreateAlias",
          input: { AliasName, TargetKeyId: KeyArn }
        },
        { kind: "GetPublicKey", input: { KeyId: AliasName } }
      ])
      // No `Tags` key at all when none were supplied.
      expect(sentCommands()[0].input).not.toHaveProperty("Tags")
    })

    it("creates an ECC_NIST_EDWARDS25519 SIGN_VERIFY key for an ED key and reads back its 32-byte point", async () => {
      const keypair = Keypair.generate()
      mockSend
        .mockResolvedValueOnce({ KeyMetadata: { Arn: KeyArn } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(ed25519PublicKeyResponse(keypair, KeyArn))
      await expect(
        KMSClientProvider.createKey(
          Region,
          SolanaAliasName,
          KeyType.ED,
          "batchop.a ED signing key"
        )
      ).resolves.toEqual({
        keyArn: KeyArn,
        keyType: KeyType.ED,
        publicKey: keypair.publicKey.toBytes()
      })
      expect(sentCommands()[0]).toEqual({
        kind: "CreateKey",
        input: {
          KeySpec: KeySpec.ECC_NIST_EDWARDS25519,
          KeyUsage: KeyUsageType.SIGN_VERIFY,
          Description: "batchop.a ED signing key"
        }
      })
    })

    it("forwards the tags on the CreateKey itself", async () => {
      answerCreation(ethers.Wallet.createRandom())
      await KMSClientProvider.createKey(Region, AliasName, KeyType.EM, "purpose", [
        { TagKey: "wire:platform-version", TagValue: "v4" }
      ])
      expect(sentCommands()[0].input.Tags).toEqual([
        { TagKey: "wire:platform-version", TagValue: "v4" }
      ])
    })

    it("validates the alias name FIRST — nothing is created for an illegal alias", async () => {
      await expect(
        KMSClientProvider.createKey(
          Region,
          "alias/wire/dev/batchop.a/EM",
          KeyType.EM,
          "p"
        )
      ).rejects.toThrow(/is not a KMS alias name/)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it("fails when CreateKey returns no ARN, before any alias is bound", async () => {
      mockSend.mockResolvedValueOnce({ KeyMetadata: {} })
      await expect(
        KMSClientProvider.createKey(Region, AliasName, KeyType.EM, "p")
      ).rejects.toThrow(/returned no key ARN/)
      expect(sentCommands().map(command => command.kind)).toEqual(["CreateKey"])
    })

    it("propagates a CreateAlias refusal (an alias already bound is never re-pointed)", async () => {
      mockSend
        .mockResolvedValueOnce({ KeyMetadata: { Arn: KeyArn } })
        .mockRejectedValueOnce(
          kmsError("AlreadyExistsException", `${AliasName} already exists`)
        )
      await expect(
        KMSClientProvider.createKey(Region, AliasName, KeyType.EM, "p")
      ).rejects.toThrow(/already exists/)
    })
  })

  describe("createSigner", () => {
    it("builds the ethers-over-KMS signer for { region, keyId }, connected to the provider", async () => {
      const provider = new ethers.JsonRpcProvider()
      const signer = await KMSClientProvider.createSigner(
        Region,
        AliasName,
        provider
      )
      expect(mockAwsKmsSigner).toHaveBeenCalledTimes(1)
      expect(mockAwsKmsSigner).toHaveBeenCalledWith(
        { region: Region, keyId: AliasName },
        provider
      )
      expect(signer).toEqual({
        config: { region: Region, keyId: AliasName },
        provider
      })
      provider.destroy()
    })

    it("signs offline (no provider) when none is given", async () => {
      await KMSClientProvider.createSigner(Region, AliasName)
      expect(mockAwsKmsSigner).toHaveBeenCalledWith(
        { region: Region, keyId: AliasName },
        null
      )
    })
  })

  describe("createSolanaSigner (the KMS arm of keyPairUtils.solanaSigner)", () => {
    /** The signer over `keypair`'s pinned point, with the KMS double answering `Sign` from the keypair itself. */
    async function signerFor(keypair: Keypair) {
      const signer = await KMSClientProvider.createSolanaSigner(
        Region,
        SolanaAliasName,
        keypair.publicKey.toBytes()
      )
      mockSend.mockImplementation(async (command: SentCommand) =>
        signResponse(keypair, command.input.Message as Uint8Array)
      )
      return signer
    }

    it("carries the pinned public key and sends ONE RAW / ED25519_SHA_512 Sign per message, returning the 64-byte signature", async () => {
      const keypair = Keypair.generate(),
        signer = await signerFor(keypair),
        message = new TextEncoder().encode("authex createlink payload")
      expect(signer.publicKey.toBase58()).toBe(keypair.publicKey.toBase58())
      const signature = await signer.signMessage(message)
      expect(signature).toEqual(nacl.sign.detached(message, keypair.secretKey))
      expect(sentCommands()).toEqual([
        {
          kind: "Sign",
          input: {
            KeyId: SolanaAliasName,
            Message: message,
            MessageType: MessageType.RAW,
            SigningAlgorithm: SigningAlgorithmSpec.ED25519_SHA_512
          }
        }
      ])
    })

    it("refuses an empty message and one over the 4096-byte KMS limit BEFORE any Sign is sent", async () => {
      const signer = await signerFor(Keypair.generate())
      await expect(signer.signMessage(new Uint8Array(0))).rejects.toThrow(
        /KMS signs messages of 1 to 4096 bytes, got 0/
      )
      await expect(
        signer.signMessage(new Uint8Array(KMSClientProvider.MaxRawMessageLength + 1))
      ).rejects.toThrow(/got 4097/)
      expect(mockSend).not.toHaveBeenCalled()
      await expect(
        signer.signMessage(new Uint8Array(KMSClientProvider.MaxRawMessageLength))
      ).resolves.toHaveLength(KMSClientProvider.Ed25519SignatureLength)
    })

    it("rejects a Sign response that is not exactly 64 bytes", async () => {
      const signer = await signerFor(Keypair.generate())
      mockSend.mockResolvedValueOnce({ Signature: new Uint8Array(63) })
      await expect(signer.signMessage(Uint8Array.of(1))).rejects.toThrow(
        /returned a 63-byte Ed25519 signature, expected 64/
      )
      mockSend.mockResolvedValueOnce({})
      await expect(signer.signMessage(Uint8Array.of(1))).rejects.toThrow(
        /returned a 0-byte Ed25519 signature, expected 64/
      )
    })

    it("rejects a signature from ANOTHER key — every signature is verified against the pinned point", async () => {
      const signer = await signerFor(Keypair.generate()),
        other = Keypair.generate()
      mockSend.mockImplementation(async (command: SentCommand) =>
        signResponse(other, command.input.Message as Uint8Array)
      )
      await expect(signer.signMessage(Uint8Array.of(1, 2, 3))).rejects.toThrow(
        /does not verify against the pinned public key/
      )
    })

    it("requires a 32-byte pinned key", async () => {
      await expect(
        KMSClientProvider.createSolanaSigner(Region, SolanaAliasName, new Uint8Array(33))
      ).rejects.toThrow(/pins a 32-byte Ed25519 public key, got 33 bytes/)
    })

    it("signs a legacy transaction over its serialized message and adds the signature, so it serializes as fully signed", async () => {
      const keypair = Keypair.generate(),
        signer = await signerFor(keypair),
        transaction = preparedTransaction(keypair.publicKey),
        signed = await signer.signTransaction(transaction)
      expect(signed).toBe(transaction)
      expect(sentCommands()[0].input.Message).toEqual(transaction.serializeMessage())
      expect(transaction.verifySignatures()).toBe(true)
      // Byte-identical to the keypair's own signing: Ed25519 is deterministic.
      const locallySigned = preparedTransaction(keypair.publicKey)
      locallySigned.recentBlockhash = transaction.recentBlockhash
      locallySigned.partialSign(keypair)
      expect(transaction.signatures[0].signature).toEqual(
        locallySigned.signatures[0].signature
      )
    })

    it("signs a versioned transaction over its compiled message", async () => {
      const keypair = Keypair.generate(),
        signer = await signerFor(keypair),
        transaction = preparedVersionedTransaction(keypair.publicKey)
      await signer.signTransaction(transaction)
      expect(sentCommands()[0].input.Message).toEqual(transaction.message.serialize())
      expect(
        nacl.sign.detached.verify(
          transaction.message.serialize(),
          transaction.signatures[0],
          keypair.publicKey.toBytes()
        )
      ).toBe(true)
    })

    it("signAllTransactions signs each in order", async () => {
      const keypair = Keypair.generate(),
        signer = await signerFor(keypair),
        transactions = [
          preparedTransaction(keypair.publicKey),
          preparedTransaction(keypair.publicKey)
        ],
        signed = await signer.signAllTransactions(transactions)
      expect(signed).toEqual(transactions)
      expect(sentCommands().map(command => command.input.Message)).toEqual(
        transactions.map(transaction => transaction.serializeMessage())
      )
      transactions.forEach(transaction =>
        expect(transaction.verifySignatures()).toBe(true)
      )
    })

    it("a transaction without its fee payer / blockhash is refused before any Sign — the caller sets both", async () => {
      const signer = await signerFor(Keypair.generate())
      await expect(signer.signTransaction(new Transaction())).rejects.toThrow()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe("per-region client cache", () => {
    it("constructs ONE KMSClient per region, with adaptive retry, and reuses it", async () => {
      const cacheRegion = "eu-central-1",
        wallet = ethers.Wallet.createRandom()
      mockSend
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
      await KMSClientProvider.getPublicKey(cacheRegion, AliasName, KeyType.EM)
      await KMSClientProvider.getPublicKey(cacheRegion, AliasName, KeyType.EM)
      expect(clientConstructionsFor(cacheRegion)).toEqual([
        { region: cacheRegion, retryMode: "adaptive", maxAttempts: 10 }
      ])
      expect(mockSend).toHaveBeenCalledTimes(2)
    })

    it("a second region gets its own client", async () => {
      const otherRegion = "ap-south-1"
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn)
      )
      await KMSClientProvider.getPublicKey(otherRegion, AliasName, KeyType.EM)
      expect(clientConstructionsFor(otherRegion)).toHaveLength(1)
    })
  })

  describe("delete", () => {
    it("has NO delete surface at all — a key under an alias is the account's durable identity", () => {
      expect(KMSClientProvider).not.toHaveProperty("deleteKey")
      expect(KMSClientProvider).not.toHaveProperty("scheduleKeyDeletion")
    })
  })
})
