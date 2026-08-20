import {
  AWSAccountName,
  AWSClusterNodeConfigSchema,
  AWSClusterNodeConfigSchemaCodec
} from "@wireio/cluster-tool-shared"

const SecretIdPattern = "/wire/{cluster}/{account}/{keyType}"

describe("AWSAccountName", () => {
  it("is an identity-mapped string enum (value === key)", () => {
    Object.entries(AWSAccountName).forEach(([key, value]) => expect(value).toBe(key))
    expect(Object.values(AWSAccountName)).toEqual(["dev", "sandbox", "test", "prod"])
  })
})

describe("AWSClusterNodeConfigSchema", () => {
  it("accepts an account + regions, defaulting ssm to null", () => {
    expect(
      AWSClusterNodeConfigSchema.parse({
        account: AWSAccountName.dev,
        regions: ["us-east-1", "eu-west-1"]
      })
    ).toEqual({
      account: AWSAccountName.dev,
      regions: ["us-east-1", "eu-west-1"],
      ssm: null
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
    expect(Object.keys(parsed).sort()).toEqual(["account", "regions", "ssm"])
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
    expect(() => AWSClusterNodeConfigSchemaCodec.deserialize('{"account":"dev"}')).toThrow(/regions/)
  })
})
