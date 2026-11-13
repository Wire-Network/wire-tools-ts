import { z } from "zod"

import { NestedError } from "@wireio/shared"
import {
  EthereumReadBlockTag,
  EthereumReadConfirmationConfigSchema,
  SchemaCodec,
  Uint32Schema,
  createUnsetEthereumReadConfirmationConfig,
  type EthereumReadConfirmationConfig
} from "@wireio/cluster-tool-shared"

const ClientConfigurationSchemaVersion = 1,
  CanonicalPositiveDecimal = /^[1-9][0-9]*$/,
  SafeIdentifier = /^[A-Za-z0-9._-]{1,64}$/,
  MaximumUint256 = (1n << 256n) - 1n

/** Nodeop's host-only protobuf spellings of the existing read block tags. */
const ProtoReadBlockTags = {
  [EthereumReadBlockTag.finalized]: "EVM_READ_BLOCK_TAG_FINALIZED",
  [EthereumReadBlockTag.safe]: "EVM_READ_BLOCK_TAG_SAFE",
  [EthereumReadBlockTag.latest]: "EVM_READ_BLOCK_TAG_LATEST"
} as const

/** Canonical positive uint256 values; the pipe protects BigInt from malformed text. */
const PositiveUint256Schema = z
  .string()
  .regex(
    CanonicalPositiveDecimal,
    "must be a canonical positive decimal string"
  )
  .pipe(
    z.string().refine(value => BigInt(value) <= MaximumUint256, {
      message: "exceeds the uint256 domain"
    })
  )

/** The four absolute local limits consumed by SEC-131. */
const EthereumTransactionPolicyShape = z.object({
  max_priority_fee_per_gas_wei: PositiveUint256Schema,
  max_fee_per_gas_wei: PositiveUint256Schema,
  max_gas_limit: PositiveUint256Schema,
  max_total_native_cost_wei: PositiveUint256Schema
})

/** A policy whose EIP-1559 priority fee cannot exceed its maximum fee. */
const EthereumTransactionPolicySchema = EthereumTransactionPolicyShape.refine(
  policy =>
    BigInt(policy.max_priority_fee_per_gas_wei) <=
    BigInt(policy.max_fee_per_gas_wei),
  {
    message: "Ethereum priority-fee cap must not exceed maximum-fee cap",
    when: payload =>
      EthereumTransactionPolicyShape.safeParse(payload.value).success
  }
)

/** Signing identity and endpoint; private key material is configured separately. */
const EthereumClientConnectionSchema = z.object({
  client_id: z
    .string()
    .regex(
      SafeIdentifier,
      "client_id must be 1-64 ASCII letters, digits, '.', '_', or '-'"
    ),
  signature_provider_id: z.string().min(1),
  rpc_url: z
    .url({ protocol: /^https?$/, hostname: /.+/ })
    .refine(value => !value.includes("#"), "rpc_url must have no fragment")
})

/** Per-client read confirmation in nodeop's ProtoJSON spelling. */
const EthereumClientReadConfirmationSchema = z
  .object({
    block_tag: z.enum(ProtoReadBlockTags).optional(),
    confirmations: Uint32Schema.positive().optional(),
    max_finality_lag_sec: Uint32Schema.positive().optional()
  })
  .refine(
    value =>
      value.block_tag == null ||
      value.block_tag === ProtoReadBlockTags[EthereumReadBlockTag.latest] ||
      (value.confirmations == null && value.max_finality_lag_sec == null),
    "confirmations and max_finality_lag_sec apply only to the latest block tag"
  )

/** One host-side signing client; absent optional fields retain nodeop's defaults. */
const EthereumClientConfigurationSchema = z.object({
  connection: EthereumClientConnectionSchema,
  chain_id: Uint32Schema.positive(),
  transaction_policy: EthereumTransactionPolicySchema.optional(),
  read_confirmation: EthereumClientReadConfirmationSchema.optional()
})

/** Exactly one shared client per operator daemon process. */
const EthereumClientConfigurationFileSchema = z.object({
  schema_version: z.literal(ClientConfigurationSchemaVersion),
  clients: z.array(EthereumClientConfigurationSchema).length(1)
})

/** Finite limits nested in one host-side Ethereum signing client. */
export type EthereumTransactionPolicy = z.infer<
  typeof EthereumTransactionPolicySchema
>
/** One signing-capable Ethereum RPC connection. */
export type EthereumClientConnection = z.infer<
  typeof EthereumClientConnectionSchema
>
/** One EVM signing client in nodeop's host-side configuration. */
export type EthereumClientConfiguration = z.infer<
  typeof EthereumClientConfigurationSchema
>
/** Versioned ProtoJSON document consumed by `--outpost-ethereum-client-config-file`. */
export type EthereumClientConfigurationFile = z.infer<
  typeof EthereumClientConfigurationFileSchema
>

/** Validates both ends of the generated host-only JSON artifact. */
const ConfigurationCodec = SchemaCodec.create<EthereumClientConfigurationFile>(
  EthereumClientConfigurationFileSchema
)

/** Construct and validate the host-only Ethereum client ProtoJSON document. */
export namespace EthereumClientConfigurationConfig {
  /** Schema revision defined by nodeop's host-only `client_config.proto`. */
  export const SchemaVersion = ClientConfigurationSchemaVersion

  /**
   * Create a client using nodeop's host-only schema, outside the OPP model bundles.
   *
   * @param clientId - Stable identifier referenced by the Ethereum plugins.
   * @param signatureProviderId - Process-local Ethereum signing-provider id.
   * @param rpcUrl - HTTP(S) Ethereum JSON-RPC endpoint.
   * @param chainId - Positive EVM chain identifier expected from the endpoint.
   * @param transactionPolicy - Optional finite local expenditure policy.
   * @param readConfirmation - The cluster's read settings; unset members retain nodeop defaults.
   * @returns A validated ProtoJSON document.
   */
  export function create(
    clientId: string,
    signatureProviderId: string,
    rpcUrl: string,
    chainId: number,
    transactionPolicy?: EthereumTransactionPolicy,
    readConfirmation: EthereumReadConfirmationConfig = createUnsetEthereumReadConfirmationConfig()
  ): EthereumClientConfigurationFile {
    const read = EthereumReadConfirmationConfigSchema.parse(readConfirmation),
      hasReadConfirmation = Object.values(read).some(value => value != null),
      configuration: EthereumClientConfigurationFile = {
        schema_version: SchemaVersion,
        clients: [
          {
            connection: {
              client_id: clientId,
              signature_provider_id: signatureProviderId,
              rpc_url: rpcUrl
            },
            chain_id: chainId,
            ...(transactionPolicy == null
              ? {}
              : { transaction_policy: transactionPolicy }),
            ...(hasReadConfirmation
              ? {
                  read_confirmation: {
                    ...(read.blockTag == null
                      ? {}
                      : { block_tag: ProtoReadBlockTags[read.blockTag] }),
                    ...(read.confirmations == null
                      ? {}
                      : { confirmations: read.confirmations }),
                    ...(read.maxFinalityLagSec == null
                      ? {}
                      : { max_finality_lag_sec: read.maxFinalityLagSec })
                  }
                }
              : {})
          }
        ]
      }
    assertValid(configuration)
    return configuration
  }

  /**
   * Validate a canonical ProtoJSON value before using it.
   * @param configuration - Host-side configuration to persist.
   * @returns The validated document.
   */
  export function toJson(
    configuration: EthereumClientConfigurationFile
  ): EthereumClientConfigurationFile {
    assertValid(configuration)
    return configuration
  }

  /**
   * Validate and serialize the generated artifact with the shared schema codec.
   * @param configuration - Host-side configuration to persist.
   * @returns Pretty-printed ProtoJSON accepted by nodeop.
   */
  export function serialize(
    configuration: EthereumClientConfigurationFile
  ): string {
    return ConfigurationCodec.serialize(configuration)
  }

  /**
   * Assert that a generated document satisfies nodeop's schema boundary.
   * @param configuration - Document to check before persisting it.
   * @returns Nothing; invalid documents throw.
   */
  export function assertValid(
    configuration: EthereumClientConfigurationFile
  ): void {
    ConfigurationCodec.validate(configuration).ifLeft(error => {
      throw new NestedError(
        `Ethereum client configuration: ${SchemaCodec.formatIssues(error)}`,
        { cause: error }
      )
    })
  }

  /**
   * Assert canonical positive uint256 policy values and EIP-1559 fee ordering.
   * @param policy - Transaction policy nested in a client configuration.
   * @returns Nothing; invalid policies throw.
   */
  export function assertTransactionPolicy(
    policy: EthereumTransactionPolicy
  ): void {
    EthereumTransactionPolicySchema.parse(policy)
  }
}
