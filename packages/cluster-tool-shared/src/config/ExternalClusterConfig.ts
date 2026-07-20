import { OperatorType } from "@wireio/opp-typescript-models"
import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { BindConfigSchema } from "./BindConfig.js"
import {
  ExternalOutpostConfigEthereumSchema,
  ExternalOutpostConfigSolanaSchema
} from "./ExternalOutpostConfig.js"
import { SignatureProviderConfigSchema } from "./SignatureProviderConfig.js"

/** True when `name` is a valid `OperatorType` member name (not a reverse-map key). */
function isOperatorTypeName(name: string): boolean {
  return typeof OperatorType[name as keyof typeof OperatorType] === "number"
}

/** The wire (JSON) form of an operator type — the member NAME, validated against the enum. */
const OperatorTypeNameSchema = z
  .string()
  .refine(isOperatorTypeName, { message: "unknown OperatorType name" })

/**
 * zod v4 codec bridging `OperatorType`: the WIRE (input) side is the member
 * NAME (`"BATCH"`, `"UNDERWRITER"`, …); the DECODED (output) side is the numeric
 * proto enum. The name is validated before decode runs, so the reverse mapping
 * is always defined.
 */
const OperatorTypeCodec = z.codec(
  OperatorTypeNameSchema,
  z.custom<OperatorType>(),
  {
    decode: (name: string): OperatorType =>
      OperatorType[name as keyof typeof OperatorType] as OperatorType,
    encode: (value: OperatorType): string => OperatorType[value]
  }
)

/**
 * One account in an {@link ExternalClusterConfig} — its WIRE account name, its
 * operator type (proto enum; JSON carries the member NAME via
 * {@link OperatorTypeCodec}), and its heterogeneous signing-key providers (one
 * per curve the account signs with: wire/bls/ethereum/solana).
 */
export const ExternalClusterConfigAccountSchema = z.object({
  /** The WIRE account name. */
  accountName: z.string().min(1),
  /** Operator role (JSON carries the `OperatorType` member NAME). */
  type: OperatorTypeCodec,
  /** The account's signing-key providers (at least one). */
  keyProviders: z.array(SignatureProviderConfigSchema).min(1)
})
/** One account in an {@link ExternalClusterConfig} — the shape of {@link ExternalClusterConfigAccountSchema}. */
export type ExternalClusterConfigAccount = z.infer<
  typeof ExternalClusterConfigAccountSchema
>

/** The accounts an external cluster run hydrates (operators, as an array — no name double-carry). */
export const ExternalClusterConfigAccountsSchema = z.object({
  /** Every provisioned operator account. */
  operators: z.array(ExternalClusterConfigAccountSchema)
})
/** The accounts section — the shape of {@link ExternalClusterConfigAccountsSchema}. */
export type ExternalClusterConfigAccounts = z.infer<
  typeof ExternalClusterConfigAccountsSchema
>

/**
 * The WIRE-depot section of an {@link ExternalClusterConfig}. `epochDurationSec`
 * is REQUIRED (flow budgets are compile-time; the config is the only transport
 * for a remote epoch); `genesisFile` is needed only by daemon-spawning
 * consumers.
 */
export const ExternalClusterConfigWireSchema = z.object({
  /** Depot epoch duration, seconds (global — the only remote-epoch transport). */
  epochDurationSec: z.number().int().positive(),
  /** Shared genesis document, when a consumer spawns nodeop. */
  genesisFile: z.string().optional()
})
/** The WIRE-depot section — the shape of {@link ExternalClusterConfigWireSchema}. */
export type ExternalClusterConfigWire = z.infer<
  typeof ExternalClusterConfigWireSchema
>

/**
 * The fully self-described external-cluster deployment payload — emitted by
 * `create-external-config`, consumed by `package` (and, later, external flow
 * runs). Every `*File`/`*Files` field resolves relative to the containing
 * config file's directory when not absolute; the per-chain sections COMPOSE the
 * {@link ExternalOutpostConfigEthereumSchema} / {@link ExternalOutpostConfigSolanaSchema}
 * shapes rather than re-declaring them.
 */
export const ExternalClusterConfigSchema = z.object({
  /** The external cluster's network binding (the Phase-1 `BindConfig`, reused). */
  bindings: BindConfigSchema,
  /** The accounts an external run hydrates. */
  accounts: ExternalClusterConfigAccountsSchema,
  /** The WIRE-depot section. */
  wire: ExternalClusterConfigWireSchema,
  /** Already-deployed Ethereum outpost references (composed). */
  ethereum: ExternalOutpostConfigEthereumSchema,
  /** Already-deployed Solana outpost references (composed), when present. */
  solana: ExternalOutpostConfigSolanaSchema.optional()
})
/** THE fully self-described external-cluster payload — the shape of {@link ExternalClusterConfigSchema}. */
export type ExternalClusterConfig = z.infer<typeof ExternalClusterConfigSchema>

/** Validated codec for `external-cluster-config.json` (both ends of the deployment). */
export const ExternalClusterConfigSchemaCodec =
  SchemaCodec.create<ExternalClusterConfig>(ExternalClusterConfigSchema)
