import { KeyType } from "@wireio/sdk-core"
import { z } from "zod"

/**
 * Provider-type roster — member/value IS the C++ scheme token verbatim
 * (`KEY:` / `SSM:` / `KIOD:` signature-provider specs, modeled on
 * `signature_provider_manager_plugin`). `KMS` is the documented next member;
 * `match().exhaustive()` forces handling when it is added.
 */
export enum SignatureProviderType {
  KEY = "KEY",
  SSM = "SSM",
  KIOD = "KIOD"
}

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

/** `KEY:` provider — carries the raw private key inline (full `KEY:`/`SSM:` parity). */
export const SignatureProviderKEYConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.KEY),
  ...signatureProviderBaseShape,
  privateKey: z.string()
})

/** `SSM:` provider — the AWS region + secret id the private key is fetched from once. */
export const SignatureProviderSSMConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.SSM),
  ...signatureProviderBaseShape,
  awsRegion: z.string(),
  awsSecretId: z.string()
})

/** `KIOD:` provider — material-less; the private key lives in the kiod wallet the consumer binds. */
export const SignatureProviderKIODConfigSchema = z.object({
  providerType: z.literal(SignatureProviderType.KIOD),
  ...signatureProviderBaseShape
})

/**
 * A signing-key provider entry, discriminated on `providerType`. A BLS entry
 * MUST carry `proofOfPossession` (enforced by the union-level refine; there is
 * no TS-side BLS public-key derivation, so the proof rides the config).
 */
export const SignatureProviderConfigSchema = z
  .discriminatedUnion("providerType", [
    SignatureProviderKEYConfigSchema,
    SignatureProviderSSMConfigSchema,
    SignatureProviderKIODConfigSchema
  ])
  .superRefine((config, ctx) => {
    if (config.type === KeyType.BLS && config.proofOfPossession == null) {
      ctx.addIssue({
        code: "custom",
        message: "BLS signature provider requires proofOfPossession",
        path: ["proofOfPossession"]
      })
    }
  })

/** `KEY:` provider config — the schema-inferred shape of {@link SignatureProviderKEYConfigSchema}. */
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
/** A signing-key provider entry — the discriminated union of the three variants. */
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
 * SSM publish settings: the AWS region + the secret-id PATTERN used when
 * publishing each generated key. Placeholders: `{cluster}` (basename of
 * clusterPath), `{account}`, `{keyType}` — e.g.
 * `/wire-sysio/{cluster}/keys/{account}/{keyType}`. Unknown placeholders fail
 * fast at resolution time.
 */
export const ClusterSignatureProviderSSMOptionsSchema = z.object({
  /** AWS region the parameters are published under. */
  awsRegion: z.string(),
  /** Secret-id pattern with `{cluster}` / `{account}` / `{keyType}` placeholders. */
  awsSecretIdPattern: z.string()
})
/** SSM publish settings — the schema-inferred shape of {@link ClusterSignatureProviderSSMOptionsSchema}. */
export type ClusterSignatureProviderSSMOptions = z.infer<
  typeof ClusterSignatureProviderSSMOptionsSchema
>

/**
 * Caller-facing cluster signature-provider options (all optional): the provider
 * TYPE the cluster generates its own signing keys under (default
 * {@link SignatureProviderType.KEY}), plus the SSM publish settings REQUIRED
 * when `type === SignatureProviderType.SSM`.
 */
export interface ClusterSignatureProviderOptions {
  /** Provider type the cluster's own signing keys are handled with. Default: KEY. */
  type?: SignatureProviderType
  /** SSM publish settings — required when `type === SSM`. */
  ssm?: ClusterSignatureProviderSSMOptions
}

/**
 * The resolved, persisted cluster signature-provider config (a member of
 * `ClusterConfig`). Schema-defaulted to `{ type: KEY, ssm: null }` so a
 * pre-existing `cluster-config.json` (written before this member existed) stays
 * loadable — the default fills the missing slot.
 */
export const ClusterSignatureProviderConfigSchema = z
  .object({
    /** Provider type the cluster's own signing keys are handled with. */
    type: z.enum(SignatureProviderType),
    /** SSM publish settings, or `null` under KEY/KIOD (round-trips through JSON). */
    ssm: ClusterSignatureProviderSSMOptionsSchema.nullable()
  })
  .default({ type: SignatureProviderType.KEY, ssm: null })
/** The resolved cluster signature-provider config — the shape of {@link ClusterSignatureProviderConfigSchema}. */
export type ClusterSignatureProviderConfig = z.infer<
  typeof ClusterSignatureProviderConfigSchema
>
