import { ethers } from "ethers"
import { KMSClientProvider } from "@wireio/cluster-tool/config/KMSClientProvider"

const mockSend = jest.fn()
// `mock`-prefixed so jest's factory hoisting allows the reference — holding the
// constructor here guarantees it is the SAME jest.fn the provider's lazy
// `import("@aws-sdk/client-kms")` receives (the SSMClientProvider suite's pattern).
const mockKMSClient = jest.fn().mockImplementation(() => ({ send: mockSend }))
jest.mock("@aws-sdk/client-kms", () => ({
  KMSClient: mockKMSClient,
  GetPublicKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetPublicKey", input })),
  CreateKeyCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateKey", input })),
  CreateAliasCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "CreateAlias", input }))
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

/** A `GetPublicKey` response for a secp256k1 signing key. */
function publicKeyResponse(
  wallet: ethers.HDNodeWallet,
  keyArn: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    KeyId: keyArn,
    PublicKey: spkiFor(wallet),
    KeySpec: KMSClientProvider.SigningKeySpec,
    KeyUsage: KMSClientProvider.SigningKeyUsage,
    ...over
  }
}

const Region = "us-east-1"
const AliasName = "alias/wire/dev/batchop-a/EM"
const KeyArn =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"

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

  describe("getPublicKey", () => {
    it("returns the key ARN + compressed point of a secp256k1 SIGN_VERIFY key", async () => {
      const wallet = ethers.Wallet.createRandom()
      mockSend.mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
      const publicKey = await KMSClientProvider.getPublicKey(Region, AliasName)
      expect(publicKey.keyArn).toBe(KeyArn)
      expect(publicKey.compressed).toEqual(compressedFor(wallet))
      expect(sentCommands()).toEqual([
        { kind: "GetPublicKey", input: { KeyId: AliasName } }
      ])
    })

    it("rejects a key of another spec — an RSA key cannot sign for ethereum", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeySpec: "RSA_2048"
        })
      )
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName)
      ).rejects.toThrow(/is a RSA_2048 key, not ECC_SECG_P256K1/)
    })

    it("rejects a key whose usage is not SIGN_VERIFY", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeyUsage: "ENCRYPT_DECRYPT"
        })
      )
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName)
      ).rejects.toThrow(/is a ENCRYPT_DECRYPT key, not SIGN_VERIFY/)
    })

    it("rejects a response carrying no public key", async () => {
      mockSend.mockResolvedValueOnce({ KeyId: KeyArn })
      await expect(
        KMSClientProvider.getPublicKey(Region, AliasName)
      ).rejects.toThrow(/returned no public key/)
    })

    it("requires a region — a KMS key is regional", async () => {
      await expect(
        KMSClientProvider.getPublicKey("", AliasName)
      ).rejects.toThrow(/a KMS key is regional — region is required/)
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe("tryGetPublicKey (the adopt probe)", () => {
    it("returns the public identity when the alias resolves", async () => {
      const wallet = ethers.Wallet.createRandom()
      mockSend.mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName)
      ).resolves.toEqual({ keyArn: KeyArn, compressed: compressedFor(wallet) })
    })

    it("returns nothing on NotFoundException — matched BY NAME, the alias simply does not exist", async () => {
      mockSend.mockRejectedValueOnce(
        kmsError("NotFoundException", `Alias ${AliasName} is not found.`)
      )
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName)
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
        KMSClientProvider.tryGetPublicKey(Region, AliasName)
      ).rejects.toThrow(/not authorized/)
    })

    it("RETHROWS a wrong-spec key rather than minting a replacement for it", async () => {
      mockSend.mockResolvedValueOnce(
        publicKeyResponse(ethers.Wallet.createRandom(), KeyArn, {
          KeySpec: "ECC_NIST_P256"
        })
      )
      await expect(
        KMSClientProvider.tryGetPublicKey(Region, AliasName)
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

    it("creates a secp256k1 SIGN_VERIFY key, binds the alias to its ARN, then reads the key back through the alias", async () => {
      const wallet = ethers.Wallet.createRandom()
      answerCreation(wallet)
      const created = await KMSClientProvider.createKey(
        Region,
        AliasName,
        "batch operator batchop.a — ethereum outpost key (EM)"
      )
      expect(created).toEqual({ keyArn: KeyArn, compressed: compressedFor(wallet) })
      expect(sentCommands()).toEqual([
        {
          kind: "CreateKey",
          input: {
            KeySpec: KMSClientProvider.SigningKeySpec,
            KeyUsage: KMSClientProvider.SigningKeyUsage,
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

    it("forwards the tags on the CreateKey itself", async () => {
      answerCreation(ethers.Wallet.createRandom())
      await KMSClientProvider.createKey(Region, AliasName, "purpose", [
        { TagKey: "wire:platform-version", TagValue: "v4" }
      ])
      expect(sentCommands()[0].input.Tags).toEqual([
        { TagKey: "wire:platform-version", TagValue: "v4" }
      ])
    })

    it("validates the alias name FIRST — nothing is created for an illegal alias", async () => {
      await expect(
        KMSClientProvider.createKey(Region, "alias/wire/dev/batchop.a/EM", "p")
      ).rejects.toThrow(/is not a KMS alias name/)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it("fails when CreateKey returns no ARN, before any alias is bound", async () => {
      mockSend.mockResolvedValueOnce({ KeyMetadata: {} })
      await expect(
        KMSClientProvider.createKey(Region, AliasName, "p")
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
        KMSClientProvider.createKey(Region, AliasName, "p")
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

  describe("per-region client cache", () => {
    it("constructs ONE KMSClient per region, with adaptive retry, and reuses it", async () => {
      const cacheRegion = "eu-central-1",
        wallet = ethers.Wallet.createRandom()
      mockSend
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
        .mockResolvedValueOnce(publicKeyResponse(wallet, KeyArn))
      await KMSClientProvider.getPublicKey(cacheRegion, AliasName)
      await KMSClientProvider.getPublicKey(cacheRegion, AliasName)
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
      await KMSClientProvider.getPublicKey(otherRegion, AliasName)
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
