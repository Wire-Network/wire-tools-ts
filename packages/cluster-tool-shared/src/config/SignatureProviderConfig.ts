import { KeyType } from "@wireio/sdk-core"
import { z } from "zod"

/**
 * Provider-type roster — member/value IS the C++ scheme token verbatim
 * (the KEY / SSM / KIOD / KMS signature-provider schemes, modeled on
 * `signature_provider_manager_plugin` + `signature_provider_kms_plugin`).
 * `KMS` is a PER-KEY custody scheme only — see {@link ClusterSignatureProviderType}.
 */
export enum SignatureProviderType {
  KEY = "KEY",
  SSM = "SSM",
  KIOD = "KIOD",
  KMS = "KMS"
}

/**
 * The provider types a CLUSTER generates its own signing keys under — the
 * cluster-wide axis. `KMS` is deliberately absent: nodeop's
 * `signature_provider_kms_plugin` signs secp256k1 / ethereum keys only, so KMS
 * can never custody a cluster's K1 / BLS / ED keys. It complements an `SSM`
 * cluster instead ({@link AWSKMSSignatureProviderOptionsSchema}), moving ONLY
 * the curves in {@link KMSCustodiedKeyTypes} out of Parameter Store.
 */
export const ClusterSignatureProviderTypes = [
  SignatureProviderType.KEY,
  SignatureProviderType.SSM,
  SignatureProviderType.KIOD
] as const
/** A cluster-wide provider type — the enum-member subset {@link ClusterSignatureProviderTypes} spells. */
export type ClusterSignatureProviderType =
  (typeof ClusterSignatureProviderTypes)[number]

/**
 * The curves AWS KMS custodies when a cluster configures it: the ethereum EM
 * key ONLY. A constant, not a config member — nodeop's KMS provider is
 * ethereum-scoped by construction, so there is nothing an operator could
 * choose here.
 */
export const KMSCustodiedKeyTypes = [KeyType.EM] as const

/**
 * The curve of a signing key — reuses sdk-core's `KeyType` (referenced by
 * member, never re-spelled as literals). `z.enum(KeyType)` directly would fold
 * the enum's merged namespace helpers (`indexFor`/`from`) into the roster, so
 * the members are listed explicitly.
 */
const KeyTypeSchema = z.enum([
  KeyType.K1,
  KeyType.R1,
  KeyType.WA,
  KeyType.EM,
  KeyType.ED,
  KeyType.BLS
])

/**
 * Fields shared by every provider variant: the signing curve, the pinned public
 * key (verified against the derived key at resolution time), and the optional
 * BLS proof-of-possession (required only for `type === KeyType.BLS`, enforced
 * on the union).
 */
const signatureProviderBaseShape = {
  type: KeyTypeSchema,
  publicKey: z.string(),
  proofOfPossession: z.string().optional()
}

/** KEY-scheme provider — carries the raw private key inline (full KEY/SSM parity). */
export const SignatureProviderKEYConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.KEY),
  ...signatureProviderBaseShape,
  privateKey: z.string()
})

/**
 * `SSM:` provider — the secret id the private key is fetched from once. The
 * rendered `--signature-provider` spec is REGION-LESS (`SSM:<secretId>`, ONE
 * colon): the depot's `signature_provider_ssm_plugin` resolves the region from
 * the ambient AWS environment chain (env vars → shared config → IMDS).
 * `awsRegions` is INFORMATIONAL — it records every region the parameter was
 * replicated to, for operators and disaster-recovery migrations; nothing
 * resolves through it, and there is no primary region.
 */
export const SignatureProviderSSMConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.SSM),
  ...signatureProviderBaseShape,
  awsRegions: z.array(z.string().min(1)).min(1),
  awsSecretId: z.string()
})

/** `KIOD:` provider — material-less; the private key lives in the kiod wallet the consumer binds. */
export const SignatureProviderKIODConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.KIOD),
  ...signatureProviderBaseShape
})

/**
 * `KMS:` provider — material-less: the private key never leaves AWS KMS, and
 * every signature is a remote `KMS::Sign`. The rendered spec is
 * `KMS:<awsKmsRegion>:<awsKmsKeyId>` — nodeop's `parse_kms_spec` shorthand
 * (`<region>:<key-id-or-alias>`), resolving the key in the daemon's own AWS
 * account. `awsKmsKeyId` is any `KeyId` KMS accepts: an alias name
 * (`alias/wire/dev/batchop-a/EM`, what the harness renders from its pattern),
 * a bare key id, or a key / alias ARN. Only the curves in
 * {@link KMSCustodiedKeyTypes} may ride this variant.
 */
export const SignatureProviderKMSConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.KMS),
  ...signatureProviderBaseShape,
  awsKmsRegion: z.string().min(1),
  awsKmsKeyId: z.string().min(1)
})

/**
 * A signing-key provider entry, discriminated on `providerType`. A BLS entry
 * MUST carry `proofOfPossession` (enforced by the union-level refine; there is
 * no TS-side BLS public-key derivation, so the proof rides the config). A KMS
 * entry MUST be one of the {@link KMSCustodiedKeyTypes} curves.
 */
export const SignatureProviderConfigSchema = z
  .discriminatedUnion("providerType", [
    SignatureProviderKEYConfigSchema,
    SignatureProviderSSMConfigSchema,
    SignatureProviderKIODConfigSchema,
    SignatureProviderKMSConfigSchema
  ])
  .superRefine((config, ctx) => {
    if (config.type === KeyType.BLS && config.proofOfPossession == null) {
      ctx.addIssue({
        code: "custom",
        message: "BLS signature provider requires proofOfPossession",
        path: ["proofOfPossession"]
      })
    }
    if (
      config.providerType === SignatureProviderType.KMS &&
      !isKMSCustodiedKeyType(config.type)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `KMS signature provider custodies ${KMSCustodiedKeyTypes.map(
          keyType => KeyType[keyType]
        ).join(", ")} keys only (got ${KeyType[config.type]})`,
        path: ["type"]
      })
    }
  })

/** KEY-scheme provider config — the schema-inferred shape of {@link SignatureProviderKEYConfigSchema}. */
export type SignatureProviderKEYConfig = z.infer<
  typeof SignatureProviderKEYConfigSchema
>
/** `SSM:` provider config — the schema-inferred shape of {@link SignatureProviderSSMConfigSchema}. */
export type SignatureProviderSSMConfig = z.infer<
  typeof SignatureProviderSSMConfigSchema
>
/** `KIOD:` provider config — the schema-inferred shape of {@link SignatureProviderKIODConfigSchema}. */
export type SignatureProviderKIODConfig = z.infer<
  typeof SignatureProviderKIODConfigSchema
>
/** `KMS:` provider config — the schema-inferred shape of {@link SignatureProviderKMSConfigSchema}. */
export type SignatureProviderKMSConfig = z.infer<
  typeof SignatureProviderKMSConfigSchema
>
/** A signing-key provider entry — the discriminated union of the four variants. */
export type SignatureProviderConfig = z.infer<
  typeof SignatureProviderConfigSchema
>

/** Named discriminator shape used to project a variant out of the union. */
interface SignatureProviderDiscriminator<T extends SignatureProviderType> {
  providerType: T
}

/**
 * The provider config variant for a specific {@link SignatureProviderType} —
 * DERIVED from the union via `Extract`, never re-spelled.
 */
export type SignatureProviderConfigOf<T extends SignatureProviderType> = Extract<
  SignatureProviderConfig,
  SignatureProviderDiscriminator<T>
>

/**
 * Whether `keyType` is a curve AWS KMS custodies ({@link KMSCustodiedKeyTypes}).
 *
 * @param keyType - The curve.
 * @returns `true` for the KMS-custodied curves.
 */
export function isKMSCustodiedKeyType(keyType: KeyType): boolean {
  return (KMSCustodiedKeyTypes as readonly KeyType[]).includes(keyType)
}

/**
 * AWS SSM publish settings: the secret-id PATTERN every generated key is
 * published under, the optional `{version}` token value, and the DERIVED
 * replication region set.
 *
 * Pattern placeholders — `{cluster}` (the AWS account the cluster runs in:
 * `dev` / `sandbox` / `test` / `prod`, sourced from `AWSClusterNodeConfig.account`),
 * `{account}` (the key's DURABLE handle — an operator handle like `batchop.a`
 * or a node name like `node_00`),
 * `{keyType}`, and the OPTIONAL `{version}`. The default pattern is the
 * 4-segment `/wire/{cluster}/{account}/{keyType}`; `{version}` is SUPPORTED but
 * is not part of it. An unknown or unfilled placeholder fails fast at
 * resolution time.
 */
export const AWSSSMSignatureProviderOptionsSchema = z.object({
  /**
   * Every AWS region the parameters are replicated to. DERIVED at resolve time
   * from `AWSClusterNodeConfig.regions`, so authoring it here alongside an
   * `awsClusterNodeConfig` is rejected. There is no primary region: every secret
   * is published to EVERY region so a disaster-recovery migration into any one
   * of them finds its parameters already present.
   */
  awsRegions: z.array(z.string().min(1)).min(1).optional(),
  /** Secret-id pattern with `{cluster}` / `{account}` / `{keyType}` / `{version}` placeholders. */
  awsSecretIdPattern: z.string(),
  /** Value for the OPTIONAL `{version}` pattern token — omit when the pattern has none. */
  version: z.string().min(1).optional()
})
/** AWS SSM publish settings — the schema-inferred shape of {@link AWSSSMSignatureProviderOptionsSchema}. */
export type AWSSSMSignatureProviderOptions = z.infer<
  typeof AWSSSMSignatureProviderOptionsSchema
>

/**
 * AWS KMS custody settings for the {@link KMSCustodiedKeyTypes} curves of an
 * `SSM` cluster: the key ALIAS pattern every such key is adopted from (and,
 * under {@link SignatureProviderKeyPolicy.adoptOrCreate}, created under) and
 * the ONE region the keys live in.
 *
 * The pattern takes the same placeholders as the SSM secret-id pattern —
 * `{cluster}` / `{account}` / `{keyType}` / `{version}` — and renders a KMS
 * alias NAME, which must start with `alias/` and may only contain
 * `[a-zA-Z0-9/_-]`. A `{account}` handle's dots (`batchop.a`) are rendered as
 * dashes (`batchop-a`) because KMS forbids them in an alias; WIRE names never
 * contain a dash, so the mapping is injective. A KMS key is REGIONAL (unlike
 * an SSM parameter, which is replicated to every region), so the region is an
 * explicit, single choice — and must be one of `AWSClusterNodeConfig.regions`.
 */
export const AWSKMSSignatureProviderOptionsSchema = z.object({
  /** Alias-name pattern with `{cluster}` / `{account}` / `{keyType}` / `{version}` placeholders. */
  awsKeyAliasPattern: z.string().min(1),
  /** The ONE region the KMS keys live in — one of `AWSClusterNodeConfig.regions`. */
  awsRegion: z.string().min(1),
  /** Value for the OPTIONAL `{version}` pattern token — omit when the pattern has none. */
  version: z.string().min(1).optional()
})
/** AWS KMS custody settings — the schema-inferred shape of {@link AWSKMSSignatureProviderOptionsSchema}. */
export type AWSKMSSignatureProviderOptions = z.infer<
  typeof AWSKMSSignatureProviderOptionsSchema
>

/**
 * How a bootstrap obtains a BATCH OPERATOR's signing keys when the custody
 * store (SSM / KMS, or a KEY cluster's own `cluster-keys.json`) has none under
 * the rendered id.
 *
 * Identity enum (value === key). Every other identity — producer nodes, the
 * genesis identity, flow-provisioned actors — always adopts-or-creates; the
 * policy governs only the operators whose keys a real launch pre-creates and
 * pre-funds (`wire-cluster-tool create-batch-operator-keys`), where silently
 * minting a replacement key would orphan the funding already bound to the
 * pre-created one.
 */
export enum SignatureProviderKeyPolicy {
  /** Adopt the existing key, else generate (and publish) a new one — the default. */
  adoptOrCreate = "adoptOrCreate",
  /** Adopt the existing key, else FAIL the bootstrap naming the missing id. */
  adoptOnly = "adoptOnly"
}

/**
 * Caller-facing cluster signature-provider options (all optional): the provider
 * TYPE the cluster generates its own signing keys under (default
 * {@link SignatureProviderType.KEY}), the SSM publish settings REQUIRED when
 * `type === SignatureProviderType.SSM`, the OPTIONAL KMS custody settings an
 * SSM cluster moves its {@link KMSCustodiedKeyTypes} keys into, and the
 * batch-operator key policy (default {@link SignatureProviderKeyPolicy.adoptOrCreate}).
 */
export interface ClusterSignatureProviderOptions {
  /** Provider type the cluster's own signing keys are handled with. Default: KEY. */
  type?: ClusterSignatureProviderType
  /** AWS SSM publish settings — required when `type === SSM`. */
  ssm?: AWSSSMSignatureProviderOptions
  /** AWS KMS custody settings for the EM keys — only valid when `type === SSM`. */
  kms?: AWSKMSSignatureProviderOptions
  /** How the bootstrap obtains the batch operators' keys. Default: adoptOrCreate. */
  batchOperatorKeyPolicy?: SignatureProviderKeyPolicy
}

/**
 * The resolved, persisted cluster signature-provider config (a member of
 * `ClusterConfig`). Schema-defaulted to KEY with no AWS settings and the
 * adopt-or-create policy, so a `cluster-config.json` without the member loads.
 */
export const ClusterSignatureProviderConfigSchema = z
  .object({
    /** Provider type the cluster's own signing keys are handled with. */
    type: z.enum(ClusterSignatureProviderTypes),
    /** AWS SSM publish settings, or `null` under KEY/KIOD (round-trips through JSON). */
    ssm: AWSSSMSignatureProviderOptionsSchema.nullable(),
    /** AWS KMS custody settings for the EM keys, or `null` (round-trips through JSON). */
    kms: AWSKMSSignatureProviderOptionsSchema.nullable().default(null),
    /** How the bootstrap obtains the batch operators' keys. */
    batchOperatorKeyPolicy: z
      .enum(SignatureProviderKeyPolicy)
      .default(SignatureProviderKeyPolicy.adoptOrCreate)
  })
  .default({
    type: SignatureProviderType.KEY,
    ssm: null,
    kms: null,
    batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
  })
/** The resolved cluster signature-provider config — the shape of {@link ClusterSignatureProviderConfigSchema}. */
export type ClusterSignatureProviderConfig = z.infer<
  typeof ClusterSignatureProviderConfigSchema
>

/**
 * Whether `keyType` lives in AWS KMS under `provider` — an `SSM` cluster with
 * KMS settings custodies its {@link KMSCustodiedKeyTypes} keys there; every
 * other combination keeps the curve in the cluster-wide provider.
 *
 * @param provider - The resolved cluster signature-provider config.
 * @param keyType - The curve.
 * @returns `true` when the key is KMS-custodied.
 */
export function isKMSCustodied(
  provider: ClusterSignatureProviderConfig,
  keyType: KeyType
): boolean {
  return (
    provider.type === SignatureProviderType.SSM &&
    provider.kms != null &&
    isKMSCustodiedKeyType(keyType)
  )
}
