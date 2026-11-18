import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import {
  AWSKMSSignatureProviderOptionsSchema,
  AWSSSMSignatureProviderOptionsSchema,
  type ClusterSignatureProviderConfig
} from "./SignatureProviderConfig.js"

/**
 * The AWS account a cluster's nodes and secrets live in. Identity enum (value
 * === key); the member IS the `{cluster}` segment of every rendered SSM
 * secret id (`/wire/{cluster}/{account}/{keyType}` → `/wire/dev/batchop.a/K1`).
 */
export enum AWSAccountName {
  dev = "dev",
  sandbox = "sandbox",
  test = "test",
  prod = "prod"
}

/**
 * The AWS placement of a cluster's nodes: which account they run in, which
 * regions their secrets are replicated across, the SSM publish settings and
 * the optional KMS custody settings for the ethereum / solana keys.
 *
 * There is deliberately NO `nodes` member, no per-node region and no default
 * region: EVERY secret is replicated to EVERY region in `regions`, so a
 * disaster-recovery migration into any one of them finds its parameters already
 * present. REQUIRED when `signatureProvider.type` is `SignatureProviderType.SSM`
 * (it sources the secret-id `{cluster}` segment and the replication regions);
 * accepted but unused under `KEY` / `KIOD`. A `kms` block moves the curves its
 * `keyTypes` names (K1, EM and ED by default — K1 for the batch operators'
 * account keys only) of an SSM cluster into AWS KMS (adopted by alias pattern,
 * never leaving KMS); its `awsRegion` must be one of `regions`.
 */
export const AWSClusterNodeConfigSchema = z.object({
  /** The AWS account the cluster runs in — also the secret-id `{cluster}` value. */
  account: z.enum(AWSAccountName),
  /** Every region the cluster's secrets are replicated to — no primary, all of them. */
  regions: z.array(z.string().min(1)).min(1),
  /** AWS SSM publish settings, or `null` (`null`, not absence, so the slot round-trips through JSON). */
  ssm: AWSSSMSignatureProviderOptionsSchema.nullable().default(null),
  /** AWS KMS custody settings for the K1 / EM / ED keys, or `null` (same JSON round-trip rule as `ssm`). */
  kms: AWSKMSSignatureProviderOptionsSchema.nullable().default(null)
})
/** The AWS placement of a cluster's nodes — the shape of {@link AWSClusterNodeConfigSchema}. */
export type AWSClusterNodeConfig = z.infer<typeof AWSClusterNodeConfigSchema>

/** Validated codec for a standalone `AWSClusterNodeConfig` document. */
export const AWSClusterNodeConfigSchemaCodec =
  SchemaCodec.create<AWSClusterNodeConfig>(AWSClusterNodeConfigSchema)

/**
 * The settings every key-custody operation renders ids from and adopts /
 * publishes through: a cluster's signature-provider config plus its AWS
 * placement. A resolved `ClusterConfig` carries both and is passed as-is; a
 * cluster-less command (`create-batch-operator-keys`) resolves them on their
 * own, without binaries, ports or a cluster directory.
 */
export interface KeyCustodySettings {
  /** The provider type, the SSM publish settings, the KMS custody settings and the key policy. */
  readonly signatureProvider: ClusterSignatureProviderConfig
  /** The AWS account, replication regions and settings the ids render from (`null` under KEY / KIOD). */
  readonly awsClusterNodeConfig: AWSClusterNodeConfig
}
