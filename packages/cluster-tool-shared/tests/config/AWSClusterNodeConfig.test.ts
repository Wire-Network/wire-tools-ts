import {
  AWSAccountName,
  AWSClusterNodeConfigSchema,
  AWSClusterNodeConfigSchemaCodec,
  ClusterSignatureProviderConfigSchema,
  SignatureProviderType,
  type ClusterConfig,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"

const SecretIdPattern = "/wire/{cluster}/{account}/{keyType}"
/** The KMS alias pattern + the ONE key region an SSM cluster's kms block carries. */
const KmsSettings = {
  awsKeyAliasPattern: "alias/wire/{cluster}/{account}/{keyType}",
  awsRegion: "us-east-1"
}

describe("AWSAccountName", () => {
  it("is an identity-mapped string enum (value === key)", () => {
    Object.entries(AWSAccountName).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
    expect(Object.values(AWSAccountName)).toEqual([
      "dev",
      "sandbox",
      "test",
      "prod"
    ])
  })
})

describe("AWSClusterNodeConfigSchema", () => {
  it("accepts an account + regions, defaulting ssm and kms to null", () => {
    expect(
      AWSClusterNodeConfigSchema.parse({
        account: AWSAccountName.dev,
        regions: ["us-east-1", "eu-west-1"]
      })
    ).toEqual({
      account: AWSAccountName.dev,
      regions: ["us-east-1", "eu-west-1"],
      ssm: null,
      kms: null
    })
  })

  it("accepts inline ssm publish settings", () => {
    const parsed = AWSClusterNodeConfigSchema.parse({
      account: AWSAccountName.prod,
      regions: ["us-east-1"],
      ssm: { awsSecretIdPattern: SecretIdPattern }
    })
    expect(parsed.ssm?.awsSecretIdPattern).toBe(SecretIdPattern)
  })

  it("rejects an unknown account name (closed set)", () => {
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        account: "staging",
        regions: ["us-east-1"]
      }).success
    ).toBe(false)
  })

  it("rejects an empty regions array — every secret needs at least one region", () => {
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        account: AWSAccountName.test,
        regions: []
      }).success
    ).toBe(false)
  })

  it("rejects an empty region name", () => {
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        account: AWSAccountName.test,
        regions: [""]
      }).success
    ).toBe(false)
  })

  it("has NO nodes / defaultRegion members (regions is the whole replication set)", () => {
    const parsed = AWSClusterNodeConfigSchema.parse({
      account: AWSAccountName.dev,
      regions: ["us-east-1"]
    })
    expect(Object.keys(parsed).sort()).toEqual([
      "account",
      "kms",
      "regions",
      "ssm"
    ])
  })
})

describe("AWSClusterNodeConfigSchemaCodec", () => {
  it("round-trips through JSON with the null ssm slot preserved", () => {
    const config = AWSClusterNodeConfigSchema.parse({
      account: AWSAccountName.test,
      regions: ["us-east-1", "us-west-2"]
    })
    const text = AWSClusterNodeConfigSchemaCodec.serialize(config)
    expect(JSON.parse(text).ssm).toBeNull()
    expect(AWSClusterNodeConfigSchemaCodec.deserialize(text)).toEqual(config)
  })

  it("check() guards the shape", () => {
    expect(
      AWSClusterNodeConfigSchemaCodec.check({
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: null
      })
    ).toBe(true)
    expect(AWSClusterNodeConfigSchemaCodec.check({ regions: [] })).toBe(false)
  })

  it("throws with the failing path when deserializing an invalid document", () => {
    expect(() =>
      AWSClusterNodeConfigSchemaCodec.deserialize('{"account":"dev"}')
    ).toThrow(/regions/)
  })
})

describe("AWSClusterNodeConfig.kms (the EM keys' KMS custody settings)", () => {
  it("defaults to null — an SSM cluster without a kms block keeps its EM keys in Parameter Store", () => {
    expect(
      AWSClusterNodeConfigSchema.parse({
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: { awsSecretIdPattern: SecretIdPattern }
      }).kms
    ).toBeNull()
  })

  it("round-trips an authored kms block through the codec, null ssm slot preserved", () => {
    const config = AWSClusterNodeConfigSchema.parse({
        account: AWSAccountName.prod,
        regions: ["us-east-1", "eu-west-1"],
        kms: KmsSettings
      }),
      text = AWSClusterNodeConfigSchemaCodec.serialize(config)
    expect(config.kms).toEqual(KmsSettings)
    expect(JSON.parse(text).kms).toEqual(KmsSettings)
    expect(JSON.parse(text).ssm).toBeNull()
    expect(AWSClusterNodeConfigSchemaCodec.deserialize(text)).toEqual(config)
  })

  it("rejects a malformed kms block (missing awsRegion / missing pattern / empty region)", () => {
    const base = { account: AWSAccountName.dev, regions: ["us-east-1"] }
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        ...base,
        kms: { awsKeyAliasPattern: KmsSettings.awsKeyAliasPattern }
      }).success
    ).toBe(false)
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        ...base,
        kms: { awsRegion: KmsSettings.awsRegion }
      }).success
    ).toBe(false)
    expect(
      AWSClusterNodeConfigSchema.safeParse({
        ...base,
        kms: { ...KmsSettings, awsRegion: "" }
      }).success
    ).toBe(false)
    expect(() =>
      AWSClusterNodeConfigSchemaCodec.deserialize(
        JSON.stringify({ ...base, kms: { awsRegion: KmsSettings.awsRegion } })
      )
    ).toThrow(/kms/)
  })
})

describe("KeyCustodySettings", () => {
  it("is structurally satisfied by a resolved ClusterConfig — the cluster passes as-is", () => {
    // A compile-time check: `ClusterConfig` carries BOTH members with the SAME
    // types, so every key-custody operation takes a cluster config unchanged.
    type ClusterConfigIsKeyCustodySettings = ClusterConfig extends KeyCustodySettings
      ? true
      : false
    const satisfied: ClusterConfigIsKeyCustodySettings = true
    expect(satisfied).toBe(true)
  })

  it("is what a cluster-less command assembles from the two schemas alone", () => {
    const settings: KeyCustodySettings = {
      signatureProvider: ClusterSignatureProviderConfigSchema.parse({
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: SecretIdPattern },
        kms: KmsSettings
      }),
      awsClusterNodeConfig: AWSClusterNodeConfigSchema.parse({
        account: AWSAccountName.dev,
        regions: ["us-east-1"]
      })
    }
    expect(settings.signatureProvider.kms).toEqual(KmsSettings)
    expect(settings.awsClusterNodeConfig.account).toBe(AWSAccountName.dev)
    // No binaries, ports or cluster directory ride the settings.
    expect(Object.keys(settings).sort()).toEqual([
      "awsClusterNodeConfig",
      "signatureProvider"
    ])
  })
})
