import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { OperatorTypeCodec } from "../types/OperatorTypeCodec.js"
import { BindConfigSchema } from "./BindConfig.js"
import {
  ExternalOutpostConfigEthereumSchema,
  ExternalOutpostConfigSolanaSchema
} from "./ExternalOutpostConfig.js"
import { SignatureProviderConfigSchema } from "./SignatureProviderConfig.js"

/**
 * One account in an {@link ExternalClusterConfig} — its WIRE account name, its
 * operator type (proto enum; JSON carries the member NAME via
 * {@link OperatorTypeCodec}), and its heterogeneous signing-key providers (one
 * per curve the account signs with: wire/wireFinalizer/ethereum/solana).
 */
export const ExternalClusterConfigAccountSchema = z.object({
  /** The WIRE account name. */
  accountName: z.string().min(1),
  /** Operator role (JSON carries the `OperatorType` member NAME). */
  type: OperatorTypeCodec.create(),
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
 * The Ethereum outpost artifacts inside a published cluster tree — the files
 * the operator daemons read, plus the chain the outpost runs on.
 */
export const ExternalClusterConfigEthereumSchema = z.object({
  /** The tree's `outpost-addrs.json` (deployed contract addresses). */
  addressFile: z.string(),
  /** The tree's `{contractName, address, abi}` files the daemons load. */
  abiFiles: z.array(z.string()),
  /** The outpost chain's id. */
  chainId: ExternalOutpostConfigEthereumSchema.shape.chainId,
  /** The outpost RPC endpoint, when the source cluster's external-outpost config set one. */
  rpcUrl: ExternalOutpostConfigEthereumSchema.shape.rpcUrl,
  /** The tree's `liqeth-addrs.json`, when the outpost has a liqEth token. */
  liqEthAddressFile: z.string().optional()
})
/** The Ethereum outpost artifacts of a published tree — the shape of {@link ExternalClusterConfigEthereumSchema}. */
export type ExternalClusterConfigEthereum = z.infer<
  typeof ExternalClusterConfigEthereumSchema
>

/**
 * The Solana outpost artifacts inside a published cluster tree — the IDL the
 * operator daemons load (its top-level `address` is the program id).
 */
export const ExternalClusterConfigSolanaSchema = z.object({
  /** The tree's `liqsol_core` IDL. */
  idlFile: z.string(),
  /** The outpost RPC endpoint, when the source cluster's external-outpost config set one. */
  rpcUrl: ExternalOutpostConfigSolanaSchema.shape.rpcUrl,
  /** The tree's `sol-mock-mints.json`, when the outpost has SPL mints. */
  mintsFile: z.string().optional()
})
/** The Solana outpost artifacts of a published tree — the shape of {@link ExternalClusterConfigSolanaSchema}. */
export type ExternalClusterConfigSolana = z.infer<
  typeof ExternalClusterConfigSolanaSchema
>

/**
 * The fully self-described external-cluster deployment payload — emitted by
 * `create-external-config`, consumed by `package` (and, later, external flow
 * runs). Every `*File`/`*Files` field resolves relative to the containing
 * config file's directory when not absolute.
 */
export const ExternalClusterConfigSchema = z.object({
  /** The external cluster's network binding (the Phase-1 `BindConfig`, reused). */
  bindings: BindConfigSchema,
  /** The accounts an external run hydrates. */
  accounts: ExternalClusterConfigAccountsSchema,
  /** The WIRE-depot section. */
  wire: ExternalClusterConfigWireSchema,
  /** The tree's Ethereum outpost artifacts. */
  ethereum: ExternalClusterConfigEthereumSchema,
  /** The tree's Solana outpost artifacts, when present. */
  solana: ExternalClusterConfigSolanaSchema.optional()
})
/** THE fully self-described external-cluster payload — the shape of {@link ExternalClusterConfigSchema}. */
export type ExternalClusterConfig = z.infer<typeof ExternalClusterConfigSchema>

/** Validated codec for `external-cluster-config.json` (both ends of the deployment). */
export const ExternalClusterConfigSchemaCodec =
  SchemaCodec.create<ExternalClusterConfig>(ExternalClusterConfigSchema)
