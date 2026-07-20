import { KeyType } from "@wireio/sdk-core"
import {
  ClusterSignatureProviderConfigSchema,
  SignatureProviderConfigSchema,
  SignatureProviderType,
  type SignatureProviderConfigOf
} from "@wireio/cluster-tool-shared"

describe("SignatureProviderType", () => {
  it("is an identity-mapped string enum (the C++ scheme tokens verbatim)", () => {
    expect(SignatureProviderType.KEY).toBe("KEY")
    expect(SignatureProviderType.SSM).toBe("SSM")
    expect(SignatureProviderType.KIOD).toBe("KIOD")
  })
})

describe("SignatureProviderConfigSchema", () => {
  it("accepts a KEY provider with an inline private key", () => {
    const config = {
      providerType: SignatureProviderType.KEY,
      type: KeyType.K1,
      publicKey: "PUB_K1_x",
      privateKey: "PVT_K1_y"
    }
    expect(SignatureProviderConfigSchema.safeParse(config).success).toBe(true)
  })

  it("accepts an SSM provider with region + secret id", () => {
    const config = {
      providerType: SignatureProviderType.SSM,
      type: KeyType.K1,
      publicKey: "PUB_K1_x",
      awsRegion: "us-east-1",
      awsSecretId: "/wire/keys/x"
    }
    expect(SignatureProviderConfigSchema.safeParse(config).success).toBe(true)
  })

  it("accepts a KIOD provider (material-less)", () => {
    const config = {
      providerType: SignatureProviderType.KIOD,
      type: KeyType.K1,
      publicKey: "PUB_K1_x"
    }
    expect(SignatureProviderConfigSchema.safeParse(config).success).toBe(true)
  })

  it("requires proofOfPossession for a BLS key, on any provider", () => {
    const withoutPop = {
      providerType: SignatureProviderType.KEY,
      type: KeyType.BLS,
      publicKey: "PUB_BLS_x",
      privateKey: "PVT_BLS_y"
    }
    const result = SignatureProviderConfigSchema.safeParse(withoutPop)
    expect(result.success).toBe(false)
    expect(result.error?.issues?.[0]?.path).toContain("proofOfPossession")
    expect(
      SignatureProviderConfigSchema.safeParse({
        ...withoutPop,
        proofOfPossession: "SIG_BLS_z"
      }).success
    ).toBe(true)
  })

  it("rejects an unknown providerType (discriminator)", () => {
    expect(
      SignatureProviderConfigSchema.safeParse({
        providerType: "BOGUS",
        type: KeyType.K1,
        publicKey: "p"
      }).success
    ).toBe(false)
  })

  it("rejects a KEY provider missing its private key", () => {
    expect(
      SignatureProviderConfigSchema.safeParse({
        providerType: SignatureProviderType.KEY,
        type: KeyType.K1,
        publicKey: "p"
      }).success
    ).toBe(false)
  })

  it("SignatureProviderConfigOf<KEY> narrows to the KEY variant (privateKey present)", () => {
    const key: SignatureProviderConfigOf<SignatureProviderType.KEY> = {
      providerType: SignatureProviderType.KEY,
      type: KeyType.K1,
      publicKey: "p",
      privateKey: "pk"
    }
    expect(key.privateKey).toBe("pk")
  })
})

describe("ClusterSignatureProviderConfigSchema", () => {
  it("defaults to { type: KEY, ssm: null } when absent", () => {
    expect(ClusterSignatureProviderConfigSchema.parse(undefined)).toEqual({
      type: SignatureProviderType.KEY,
      ssm: null
    })
  })

  it("validates the ssm-settings shape when provided", () => {
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegion: "us-east-1",
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        }
      }).success
    ).toBe(true)
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.SSM,
        ssm: { awsRegion: "us-east-1" }
      }).success
    ).toBe(false)
  })
})
