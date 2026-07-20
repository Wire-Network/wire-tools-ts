import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { SignatureProviderConfigProvider } from "@wireio/cluster-tool/config"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"

const mockSend = jest.fn()
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input }))
}))

describe("SignatureProviderConfigProvider.resolve", () => {
  beforeEach(() => mockSend.mockReset())

  describe("KEY", () => {
    it("hydrates + verifies an ED key pair", async () => {
      const ed = PrivateKey.generate(KeyType.ED)
      const resolution = await SignatureProviderConfigProvider.resolve<
        SignatureProviderType.KEY,
        KeyType.ED
      >({
        providerType: SignatureProviderType.KEY,
        type: KeyType.ED,
        publicKey: ed.toPublic().toString(),
        privateKey: ed.toString()
      })
      expect(resolution.keyPair.type).toBe(KeyType.ED)
      expect(resolution.keyPair.publicKey).toBe(ed.toPublic().toString())
    })

    it("rejects a pinned public key that does not match the private key", async () => {
      const ed = PrivateKey.generate(KeyType.ED),
        other = PrivateKey.generate(KeyType.ED)
      await expect(
        SignatureProviderConfigProvider.resolve({
          providerType: SignatureProviderType.KEY,
          type: KeyType.ED,
          publicKey: other.toPublic().toString(),
          privateKey: ed.toString()
        })
      ).rejects.toThrow(/pinned public key does not match/)
    })

    it("derives the ethereum address for an EM key pair", async () => {
      const em = ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
      const resolution = await SignatureProviderConfigProvider.resolve<
        SignatureProviderType.KEY,
        KeyType.EM
      >({
        providerType: SignatureProviderType.KEY,
        type: KeyType.EM,
        publicKey: em.publicKey,
        privateKey: em.privateKey
      })
      expect(resolution.keyPair.address).toBe(em.address)
    })

    it("does NOT verify a BLS public key (exempt) but carries the proof of possession", async () => {
      const resolution = await SignatureProviderConfigProvider.resolve<
        SignatureProviderType.KEY,
        KeyType.BLS
      >({
        providerType: SignatureProviderType.KEY,
        type: KeyType.BLS,
        publicKey: "PUB_BLS_unverified",
        privateKey: "PVT_BLS_unverified",
        proofOfPossession: "SIG_BLS_pop"
      })
      expect(resolution.keyPair.proofOfPossession).toBe("SIG_BLS_pop")
    })
  })

  describe("SSM (jest module mock — no live AWS)", () => {
    function ssmResolve() {
      const ed = PrivateKey.generate(KeyType.ED)
      return SignatureProviderConfigProvider.resolve<
        SignatureProviderType.SSM,
        KeyType.ED
      >({
        providerType: SignatureProviderType.SSM,
        type: KeyType.ED,
        publicKey: ed.toPublic().toString(),
        awsRegion: "us-east-1",
        awsSecretId: "/wire/keys/x"
      })
    }

    it("fetches a SecureString, trims it, and hydrates the key", async () => {
      const ed = PrivateKey.generate(KeyType.ED)
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "SecureString", Value: `  ${ed.toString()}  ` }
      })
      const resolution = await SignatureProviderConfigProvider.resolve<
        SignatureProviderType.SSM,
        KeyType.ED
      >({
        providerType: SignatureProviderType.SSM,
        type: KeyType.ED,
        publicKey: ed.toPublic().toString(),
        awsRegion: "us-east-1",
        awsSecretId: "/wire/keys/x"
      })
      expect(resolution.keyPair.privateKey).toBe(ed.toString())
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it("rejects a non-SecureString parameter", async () => {
      mockSend.mockResolvedValueOnce({ Parameter: { Type: "String", Value: "x" } })
      await expect(ssmResolve()).rejects.toThrow(/must be a SecureString/)
    })

    it("rejects a missing parameter", async () => {
      mockSend.mockResolvedValueOnce({})
      await expect(ssmResolve()).rejects.toThrow(/not found/)
    })

    it("rejects an empty (whitespace-only) value", async () => {
      mockSend.mockResolvedValueOnce({
        Parameter: { Type: "SecureString", Value: "   " }
      })
      await expect(ssmResolve()).rejects.toThrow(/is empty/)
    })
  })

  describe("KIOD", () => {
    it("resolves material-less (carries no keyPair)", async () => {
      const resolution = await SignatureProviderConfigProvider.resolve<
        SignatureProviderType.KIOD,
        KeyType.K1
      >({
        providerType: SignatureProviderType.KIOD,
        type: KeyType.K1,
        publicKey: "PUB_K1_x"
      })
      expect(resolution).not.toHaveProperty("keyPair")
      expect(resolution.providerType).toBe(SignatureProviderType.KIOD)
    })
  })
})
