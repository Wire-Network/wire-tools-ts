import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"

/**
 * An already-deployed Ethereum outpost's structural references. All `*File`
 * fields resolve relative to the containing config file's directory when not
 * absolute (the shared resolver). Used by `create --external-outpost-config`
 * and composed into {@link ExternalClusterConfig}'s ethereum section.
 */
export const ExternalOutpostConfigEthereumSchema = z.object({
  /** The deploy's `outpost-addrs.json` — REQUIRED (ETH addresses are deploy-time-random). */
  addressFile: z.string(),
  /**
   * The generated per-contract `{contractName, address, abi}` files (the
   * `OperatorDaemonArtifacts` ethereumAbiFiles set); no checkout fallback.
   */
  abiFiles: z.array(z.string()),
  /**
   * The REAL chain id (today's `networkFromConfig` hardcodes
   * `AnvilProcess.DefaultChainId` — wrong for a live chain).
   */
  chainId: z.number().int().positive(),
  /**
   * The liqEth deploy's `liqeth-addrs.json` (the `LiqEthToken` etc. addresses).
   * The MATERIALIZE step copies it to `<clusterPath>/data/ethereum-deployments/liqeth-addrs.json`
   * so `RegistrySteps` reads it from `dataPath` UNCHANGED. Optional — omit when
   * the outpost has no liqEth token.
   */
  liqEthAddressFile: z.string().optional()
})
/** An already-deployed Ethereum outpost — the shape of {@link ExternalOutpostConfigEthereumSchema}. */
export type ExternalOutpostConfigEthereum = z.infer<
  typeof ExternalOutpostConfigEthereumSchema
>

/**
 * An already-deployed Solana outpost's structural references — the IDL is the
 * SOLE source; the program id is parsed from it (`declare_id!`-pinned).
 */
export const ExternalOutpostConfigSolanaSchema = z.object({
  /** The `opp-outpost` IDL file — SOLE IDL source; program id parsed from it. */
  idlFile: z.string(),
  /**
   * The SPL mints file (`sol-mock-mints.json` — array of `{code, mint, decimals}`).
   * The MATERIALIZE step copies it to `<clusterPath>/data/sol-mock-mints.json` so
   * `RegistrySteps` reads it from `dataPath` UNCHANGED. Optional — omit when the
   * outpost has no SPL/LIQ tokens.
   */
  mintsFile: z.string().optional()
})
/** An already-deployed Solana outpost — the shape of {@link ExternalOutpostConfigSolanaSchema}. */
export type ExternalOutpostConfigSolana = z.infer<
  typeof ExternalOutpostConfigSolanaSchema
>

/**
 * The per-chain already-deployed-outpost description, defined ONCE and composed
 * by BOTH the `create --external-outpost-config` input and
 * {@link ExternalClusterConfig}. When present on a `ClusterConfig`, `create`
 * starts NEITHER anvil NOR solana-test-validator, deploys nothing, and gates
 * success on the reported head block instead of epoch distribution.
 */
export const ExternalOutpostConfigSchema = z.object({
  /** Already-deployed Ethereum outpost references. */
  ethereum: ExternalOutpostConfigEthereumSchema,
  /** Already-deployed Solana outpost references. */
  solana: ExternalOutpostConfigSolanaSchema
})
/** The per-chain already-deployed-outpost description — the shape of {@link ExternalOutpostConfigSchema}. */
export type ExternalOutpostConfig = z.infer<typeof ExternalOutpostConfigSchema>

/** Validated codec for the `--external-outpost-config` input file. */
export const ExternalOutpostConfigSchemaCodec =
  SchemaCodec.create<ExternalOutpostConfig>(ExternalOutpostConfigSchema)
