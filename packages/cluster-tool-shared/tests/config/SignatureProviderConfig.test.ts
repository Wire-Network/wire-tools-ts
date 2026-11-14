import { KeyType } from "@wireio/sdk-core"
import {
  AWSKMSSignatureProviderOptionsSchema,
  AWSSSMSignatureProviderOptionsSchema,
  ClusterSignatureProviderConfigSchema,
  ClusterSignatureProviderTypes,
  isKMSCustodiableKeyType,
  isKMSCustodied,
  isKMSCustodiedKeyType,
  KMSCustodiedKeyTypes,
  SignatureProviderConfigSchema,
  SignatureProviderKeyPolicy,
  SignatureProviderKMSConfigSchema,
  SignatureProviderType,
  type AWSKMSSignatureProviderOptions,
  type ClusterSignatureProviderConfig,
  type SignatureProviderConfigOf
} from "@wireio/cluster-tool-shared"

/** A KMS alias name of the shape the harness renders (`{account}` dots mapped to dashes). */
const KmsAliasName = "alias/wire/dev/batchop-a/EM"
/** The ONE region a KMS key lives in. */
const KmsRegion = "us-east-1"
/** The alias-name pattern the cluster renders {@link KmsAliasName} from. */
const KmsAliasPattern = "alias/wire/{cluster}/{account}/{keyType}"

/** The resolved cluster provider config for `type`, with optional KMS settings. */
function clusterProvider(
  type: ClusterSignatureProviderConfig["type"],
  kms: ClusterSignatureProviderConfig["kms"] = null
): ClusterSignatureProviderConfig {
  return {
    type,
    ssm:
      type === SignatureProviderType.SSM
        ? { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
        : null,
    kms,
    batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
  }
}

describe("SignatureProviderType", () => {
  it("is an identity-mapped string enum (the C++ scheme tokens verbatim)", () => {
    expect(SignatureProviderType.KEY).toBe("KEY")
    expect(SignatureProviderType.SSM).toBe("SSM")
    expect(SignatureProviderType.KIOD).toBe("KIOD")
    expect(SignatureProviderType.KMS).toBe("KMS")
    Object.entries(SignatureProviderType).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
  })
})

describe("ClusterSignatureProviderTypes (the cluster-wide axis)", () => {
  it("lists KEY / SSM / KIOD and EXCLUDES KMS — a per-key custody scheme, never the cluster type", () => {
    expect(ClusterSignatureProviderTypes).toEqual([
      SignatureProviderType.KEY,
      SignatureProviderType.SSM,
      SignatureProviderType.KIOD
    ])
    expect(ClusterSignatureProviderTypes).not.toContain(
      SignatureProviderType.KMS
    )
  })

  it("the cluster config schema refuses KMS as the cluster type", () => {
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.KMS,
        ssm: null
      }).success
    ).toBe(false)
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.KIOD,
        ssm: null
      }).success
    ).toBe(true)
  })
})

describe("SignatureProviderKMSConfigSchema", () => {
  const kmsEntry = {
    // `as const` keeps the discriminant the KMS member, not the widened enum.
    providerType: SignatureProviderType.KMS as const,
    type: KeyType.EM,
    publicKey: "PUB_EM_x",
    awsKmsRegion: KmsRegion,
    awsKmsKeyId: KmsAliasName
  }

  it("accepts a material-less KMS entry carrying its region + key id", () => {
    expect(SignatureProviderKMSConfigSchema.safeParse(kmsEntry).success).toBe(
      true
    )
    expect(SignatureProviderConfigSchema.safeParse(kmsEntry).success).toBe(true)
  })

  it("requires awsKmsRegion AND awsKmsKeyId, each non-empty", () => {
    const { awsKmsRegion: _region, ...withoutRegion } = kmsEntry,
      { awsKmsKeyId: _keyId, ...withoutKeyId } = kmsEntry
    expect(
      SignatureProviderKMSConfigSchema.safeParse(withoutRegion).success
    ).toBe(false)
    expect(
      SignatureProviderKMSConfigSchema.safeParse(withoutKeyId).success
    ).toBe(false)
    expect(
      SignatureProviderKMSConfigSchema.safeParse({ ...kmsEntry, awsKmsRegion: "" })
        .success
    ).toBe(false)
    expect(
      SignatureProviderKMSConfigSchema.safeParse({ ...kmsEntry, awsKmsKeyId: "" })
        .success
    ).toBe(false)
  })

  it("accepts an ED (solana) KMS entry — another curve KMS custodies", () => {
    expect(
      SignatureProviderConfigSchema.safeParse({
        ...kmsEntry,
        type: KeyType.ED,
        publicKey: "PUB_ED_x",
        awsKmsKeyId: "alias/wire/dev/batchop-a/ED"
      }).success
    ).toBe(true)
  })

  it("accepts a K1 (wire) KMS entry — a batch operator's account key custodied since wire-sysio #768", () => {
    expect(
      SignatureProviderConfigSchema.safeParse({
        ...kmsEntry,
        type: KeyType.K1,
        publicKey: "PUB_K1_x",
        awsKmsKeyId: "alias/wire/dev/batchop-a/K1"
      }).success
    ).toBe(true)
  })

  it("the union refine REJECTS a KMS entry whose curve is none of K1 / EM / ED, naming the custodiable curves", () => {
    const result = SignatureProviderConfigSchema.safeParse({
      ...kmsEntry,
      type: KeyType.R1,
      publicKey: "PUB_R1_x"
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues?.[0]?.path).toEqual(["type"])
    expect(result.error?.issues?.[0]?.message).toMatch(/K1, EM, ED keys only \(got R1\)/)
    // A BLS key is never custodiable either — the finalizer key has no KMS form.
    expect(
      SignatureProviderConfigSchema.safeParse({
        ...kmsEntry,
        type: KeyType.BLS,
        publicKey: "PUB_BLS_x",
        proofOfPossession: "SIG_BLS_x"
      }).success
    ).toBe(false)
  })

  it("SignatureProviderConfigOf<KMS> narrows to the KMS variant (region + key id, no privateKey)", () => {
    const kms: SignatureProviderConfigOf<SignatureProviderType.KMS> = kmsEntry
    expect(kms.awsKmsKeyId).toBe(KmsAliasName)
    expect(kms).not.toHaveProperty("privateKey")
  })
})

describe("AWSKMSSignatureProviderOptionsSchema", () => {
  it("requires the alias pattern + the ONE region; version stays optional", () => {
    const parsed = AWSKMSSignatureProviderOptionsSchema.parse({
      awsKeyAliasPattern: KmsAliasPattern,
      awsRegion: KmsRegion
    })
    expect(parsed).toEqual({
      awsKeyAliasPattern: KmsAliasPattern,
      awsRegion: KmsRegion,
      keyTypes: [KeyType.K1, KeyType.EM, KeyType.ED]
    })
    expect(parsed.version).toBeUndefined()
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({ awsRegion: KmsRegion })
        .success
    ).toBe(false)
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({
        awsKeyAliasPattern: KmsAliasPattern
      }).success
    ).toBe(false)
  })

  it("accepts an authored version and rejects an empty one / empty region", () => {
    expect(
      AWSKMSSignatureProviderOptionsSchema.parse({
        awsKeyAliasPattern: `${KmsAliasPattern}/{version}`,
        awsRegion: KmsRegion,
        version: "v2"
      }).version
    ).toBe("v2")
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({
        awsKeyAliasPattern: KmsAliasPattern,
        awsRegion: KmsRegion,
        version: ""
      }).success
    ).toBe(false)
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({
        awsKeyAliasPattern: KmsAliasPattern,
        awsRegion: ""
      }).success
    ).toBe(false)
  })

  it("does NOT validate the pattern's shape (the alias grammar is checked at resolve time)", () => {
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({
        awsKeyAliasPattern: "not-an-alias",
        awsRegion: KmsRegion
      }).success
    ).toBe(true)
  })
})

describe("SignatureProviderKeyPolicy", () => {
  it("is an identity-mapped string enum with exactly the two policies", () => {
    Object.entries(SignatureProviderKeyPolicy).forEach(([key, value]) =>
      expect(value).toBe(key)
    )
    expect(Object.values(SignatureProviderKeyPolicy).sort()).toEqual(
      ["adoptOnly", "adoptOrCreate"].sort()
    )
  })

  it("the cluster schema defaults kms to null and the policy to adoptOrCreate on an SSM config", () => {
    expect(
      ClusterSignatureProviderConfigSchema.parse({
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      })
    ).toEqual({
      type: SignatureProviderType.SSM,
      ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" },
      kms: null,
      batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
    })
    expect(
      ClusterSignatureProviderConfigSchema.parse({
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/p" },
        kms: { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion },
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
      })
    ).toMatchObject({
      // A persisted kms block without keyTypes loads custodying every curve.
      kms: {
        awsKeyAliasPattern: KmsAliasPattern,
        awsRegion: KmsRegion,
        keyTypes: [KeyType.K1, KeyType.EM, KeyType.ED]
      },
      batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
    })
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/p" },
        batchOperatorKeyPolicy: "createAlways"
      }).success
    ).toBe(false)
  })
})

describe("AWSKMSSignatureProviderOptionsSchema.keyTypes (which custodiable curves live in KMS)", () => {
  const base = { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion }

  it("defaults to EVERY custodiable curve — K1, EM and ED", () => {
    expect(AWSKMSSignatureProviderOptionsSchema.parse(base).keyTypes).toEqual([
      KeyType.K1,
      KeyType.EM,
      KeyType.ED
    ])
    expect(AWSKMSSignatureProviderOptionsSchema.parse(base).keyTypes).toEqual([
      ...KMSCustodiedKeyTypes
    ])
  })

  it("accepts an authored subset — [\"EM\", \"ED\"] keeps K1 in Parameter Store (a nodeop without #768), [\"EM\"] keeps ED there too, [\"K1\"] alone is valid", () => {
    expect(
      AWSKMSSignatureProviderOptionsSchema.parse({
        ...base,
        keyTypes: [KeyType.EM, KeyType.ED]
      }).keyTypes
    ).toEqual([KeyType.EM, KeyType.ED])
    expect(
      AWSKMSSignatureProviderOptionsSchema.parse({ ...base, keyTypes: [KeyType.EM] })
        .keyTypes
    ).toEqual([KeyType.EM])
    expect(
      AWSKMSSignatureProviderOptionsSchema.parse({ ...base, keyTypes: [KeyType.ED] })
        .keyTypes
    ).toEqual([KeyType.ED])
    expect(
      AWSKMSSignatureProviderOptionsSchema.parse({ ...base, keyTypes: [KeyType.K1] })
        .keyTypes
    ).toEqual([KeyType.K1])
  })

  it("rejects an empty roster, a repeated curve and a curve KMS cannot custody", () => {
    expect(
      AWSKMSSignatureProviderOptionsSchema.safeParse({ ...base, keyTypes: [] }).success
    ).toBe(false)
    const repeated = AWSKMSSignatureProviderOptionsSchema.safeParse({
      ...base,
      keyTypes: [KeyType.EM, KeyType.EM]
    })
    expect(repeated.success).toBe(false)
    expect(repeated.error?.issues?.[0]?.message).toMatch(/must not repeat a curve/)
    const repeatedWire = AWSKMSSignatureProviderOptionsSchema.safeParse({
      ...base,
      keyTypes: [KeyType.K1, KeyType.EM, KeyType.K1]
    })
    expect(repeatedWire.success).toBe(false)
    expect(repeatedWire.error?.issues?.[0]?.message).toMatch(/must not repeat a curve/)
    ;[KeyType.BLS, KeyType.R1, KeyType.WA, "secp256k1"].forEach(keyType =>
      expect(
        AWSKMSSignatureProviderOptionsSchema.safeParse({ ...base, keyTypes: [keyType] })
          .success
      ).toBe(false)
    )
  })
})

describe("isKMSCustodiableKeyType / isKMSCustodiedKeyType / isKMSCustodied", () => {
  /** Resolved kms settings custodying `keyTypes`. */
  function kmsSettings(
    keyTypes: AWSKMSSignatureProviderOptions["keyTypes"]
  ): AWSKMSSignatureProviderOptions {
    return { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion, keyTypes }
  }

  it("KMS CAN custody the K1, EM and ED curves, and no other", () => {
    expect(KMSCustodiedKeyTypes).toEqual([KeyType.K1, KeyType.EM, KeyType.ED])
    expect(isKMSCustodiableKeyType(KeyType.K1)).toBe(true)
    expect(isKMSCustodiableKeyType(KeyType.EM)).toBe(true)
    expect(isKMSCustodiableKeyType(KeyType.ED)).toBe(true)
    ;[KeyType.BLS, KeyType.R1, KeyType.WA].forEach(keyType =>
      expect(isKMSCustodiableKeyType(keyType)).toBe(false)
    )
  })

  it("isKMSCustodiedKeyType answers from the settings' keyTypes, never the roster", () => {
    const every = kmsSettings([KeyType.K1, KeyType.EM, KeyType.ED]),
      outpostOnly = kmsSettings([KeyType.EM, KeyType.ED]),
      ethereumOnly = kmsSettings([KeyType.EM])
    expect(isKMSCustodiedKeyType(KeyType.K1, every)).toBe(true)
    expect(isKMSCustodiedKeyType(KeyType.EM, every)).toBe(true)
    expect(isKMSCustodiedKeyType(KeyType.ED, every)).toBe(true)
    expect(isKMSCustodiedKeyType(KeyType.EM, outpostOnly)).toBe(true)
    expect(isKMSCustodiedKeyType(KeyType.ED, outpostOnly)).toBe(true)
    // [EM, ED] keeps K1 in SSM — the roster for a nodeop without wire-sysio #768.
    expect(isKMSCustodiedKeyType(KeyType.K1, outpostOnly)).toBe(false)
    expect(isKMSCustodiedKeyType(KeyType.EM, ethereumOnly)).toBe(true)
    expect(isKMSCustodiedKeyType(KeyType.ED, ethereumOnly)).toBe(false)
    expect(isKMSCustodiedKeyType(KeyType.K1, ethereumOnly)).toBe(false)
  })

  it("an SSM cluster WITH kms settings custodies the curves they name in KMS", () => {
    const provider = clusterProvider(
      SignatureProviderType.SSM,
      kmsSettings([KeyType.K1, KeyType.EM, KeyType.ED])
    )
    // CURVE-level: whether a given ACCOUNT's K1 is custodied is the harness's
    // `ClusterConfigProvider.isKMSCustodiedKey` (batch operators only).
    expect(isKMSCustodied(provider, KeyType.K1)).toBe(true)
    expect(isKMSCustodied(provider, KeyType.EM)).toBe(true)
    expect(isKMSCustodied(provider, KeyType.ED)).toBe(true)
    // [EM, ED] keeps K1 in SSM.
    const outpostOnly = clusterProvider(
      SignatureProviderType.SSM,
      kmsSettings([KeyType.EM, KeyType.ED])
    )
    expect(isKMSCustodied(outpostOnly, KeyType.K1)).toBe(false)
    expect(isKMSCustodied(outpostOnly, KeyType.EM)).toBe(true)
    expect(isKMSCustodied(outpostOnly, KeyType.ED)).toBe(true)
    // [EM] keeps ED in SSM.
    const ethereumOnly = clusterProvider(
      SignatureProviderType.SSM,
      kmsSettings([KeyType.EM])
    )
    expect(isKMSCustodied(ethereumOnly, KeyType.EM)).toBe(true)
    expect(isKMSCustodied(ethereumOnly, KeyType.ED)).toBe(false)
  })

  it("every other combination keeps the curve in the cluster-wide provider", () => {
    const kms = kmsSettings([KeyType.K1, KeyType.EM, KeyType.ED])
    // KEY + kms: KMS complements an SSM cluster only.
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.KEY, kms), KeyType.EM)
    ).toBe(false)
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.KEY, kms), KeyType.K1)
    ).toBe(false)
    // SSM without kms: the K1 / EM / ED keys are SSM parameters like every other curve.
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.SSM), KeyType.K1)
    ).toBe(false)
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.SSM), KeyType.EM)
    ).toBe(false)
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.SSM), KeyType.ED)
    ).toBe(false)
    // SSM + kms, a curve KMS cannot custody: never KMS.
    expect(
      isKMSCustodied(clusterProvider(SignatureProviderType.SSM, kms), KeyType.BLS)
    ).toBe(false)
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

  it("accepts an SSM provider with replication regions + secret id", () => {
    const config = {
      providerType: SignatureProviderType.SSM,
      type: KeyType.K1,
      publicKey: "PUB_K1_x",
      awsRegions: ["us-east-1", "eu-west-1"],
      awsSecretId: "/wire/keys/x"
    }
    expect(SignatureProviderConfigSchema.safeParse(config).success).toBe(true)
  })

  it("rejects an SSM provider whose awsRegions is empty or absent", () => {
    const base = {
      providerType: SignatureProviderType.SSM,
      type: KeyType.K1,
      publicKey: "PUB_K1_x",
      awsSecretId: "/wire/keys/x"
    }
    expect(SignatureProviderConfigSchema.safeParse(base).success).toBe(false)
    expect(
      SignatureProviderConfigSchema.safeParse({ ...base, awsRegions: [] })
        .success
    ).toBe(false)
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
  it("defaults to KEY with no AWS settings and the adopt-or-create policy when absent", () => {
    expect(ClusterSignatureProviderConfigSchema.parse(undefined)).toEqual({
      type: SignatureProviderType.KEY,
      ssm: null,
      kms: null,
      batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
    })
  })

  it("validates the ssm-settings shape when provided", () => {
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      }).success
    ).toBe(true)
    // awsSecretIdPattern is the ONE required member.
    expect(
      ClusterSignatureProviderConfigSchema.safeParse({
        type: SignatureProviderType.SSM,
        ssm: { awsRegions: ["us-east-1"] }
      }).success
    ).toBe(false)
  })
})

describe("AWSSSMSignatureProviderOptionsSchema", () => {
  it("leaves awsRegions + version optional (both derived / opt-in)", () => {
    const parsed = AWSSSMSignatureProviderOptionsSchema.parse({
      awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
    })
    expect(parsed.awsRegions).toBeUndefined()
    expect(parsed.version).toBeUndefined()
  })

  it("accepts an explicitly authored awsRegions + version", () => {
    expect(
      AWSSSMSignatureProviderOptionsSchema.parse({
        awsRegions: ["us-east-1", "eu-west-1"],
        awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}/{version}",
        version: "v2"
      })
    ).toEqual({
      awsRegions: ["us-east-1", "eu-west-1"],
      awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}/{version}",
      version: "v2"
    })
  })

  it("rejects an empty awsRegions array and an empty version", () => {
    expect(
      AWSSSMSignatureProviderOptionsSchema.safeParse({
        awsSecretIdPattern: "/p",
        awsRegions: []
      }).success
    ).toBe(false)
    expect(
      AWSSSMSignatureProviderOptionsSchema.safeParse({
        awsSecretIdPattern: "/p",
        version: ""
      }).success
    ).toBe(false)
  })

  it("does NOT validate the pattern's shape (canonical-form checks live in resolve)", () => {
    expect(
      AWSSSMSignatureProviderOptionsSchema.safeParse({
        awsSecretIdPattern: "p"
      }).success
    ).toBe(true)
  })
})
