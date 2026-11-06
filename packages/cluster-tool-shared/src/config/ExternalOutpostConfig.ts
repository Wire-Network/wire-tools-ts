import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import {
  EvmAddressPattern,
  SolanaAddressPattern
} from "../types/chainAddressPatterns.js"
import { SolanaMintRecordSchema } from "../types/SolanaMintRecord.js"

/** Companion constants for {@link ExternalOutpostConfigSchema}. */
export namespace ExternalOutpostConfig {
  /**
   * The outpost contracts the operator daemons load an ABI for — each ABI
   * embeds the contract's deployed address, so `outpostAddresses` must carry
   * every one (`sysio.chains::setoutpost` also registers OPP + OPPInbound).
   * Adding a name here makes every external-outpost config without it invalid.
   */
  export const RequiredOutpostContractNames = ["OPP", "OPPInbound", "BAR"] as const
}

/**
 * A deploy's contract-name → address map: the content of the wire-ethereum
 * deploy record it is copied from (`outpost-addrs-<network>.json`,
 * `liqeth-addrs-<network>.json`).
 */
const EthereumAddressMapSchema = z.record(
  z.string().min(1),
  z.string().regex(EvmAddressPattern)
)

/**
 * An already-deployed Ethereum outpost: its chain id, an optional RPC endpoint
 * and the deployed contract addresses. Values only — the ABI files are built
 * from the wire-ethereum source with these addresses overlaid.
 */
export const ExternalOutpostConfigEthereumSchema = z.strictObject({
  /** The outpost chain's id (e.g. 560048 for Hoodi). */
  chainId: z.number().int().positive(),
  /**
   * The outpost RPC endpoint the operator daemons dial. When set it wins over
   * the bind config's `anvil` address; omit it when the bind config carries the
   * endpoint.
   */
  rpcUrl: z.string().optional(),
  /**
   * The outpost deploy's contract addresses (`outpost-addrs-<network>.json`).
   * Must carry every {@link ExternalOutpostConfig.RequiredOutpostContractNames}
   * member.
   */
  outpostAddresses: EthereumAddressMapSchema.superRefine((addresses, ctx) =>
    ExternalOutpostConfig.RequiredOutpostContractNames.filter(
      name => addresses[name] == null
    ).forEach(name =>
      ctx.addIssue({
        code: "custom",
        message: `outpostAddresses is missing the ${name} address`,
        path: [name]
      })
    )
  ),
  /**
   * The liqEth deploy's contract addresses (`liqeth-addrs-<network>.json`).
   * Omit when the outpost has no liqEth token.
   */
  liqEthAddresses: EthereumAddressMapSchema.optional()
})
/** An already-deployed Ethereum outpost — the shape of {@link ExternalOutpostConfigEthereumSchema}. */
export type ExternalOutpostConfigEthereum = z.infer<
  typeof ExternalOutpostConfigEthereumSchema
>

/**
 * An already-deployed Solana outpost: an optional RPC endpoint, the
 * `liqsol_core` program id and its SPL mints. Values only — the IDL is built
 * from the wire-solana source with this program id overlaid.
 */
export const ExternalOutpostConfigSolanaSchema = z.strictObject({
  /**
   * The outpost RPC endpoint the operator daemons dial. When set it wins over
   * the bind config's `solana` address; omit it when the bind config carries
   * the endpoint.
   */
  rpcUrl: z.string().optional(),
  /** The deployed `liqsol_core` program id (base58 public key). */
  programId: z.string().regex(SolanaAddressPattern),
  /** The outpost's SPL mints. Omit when the outpost has no SPL / LIQ tokens. */
  mints: z.array(SolanaMintRecordSchema).optional()
})
/** An already-deployed Solana outpost — the shape of {@link ExternalOutpostConfigSolanaSchema}. */
export type ExternalOutpostConfigSolana = z.infer<
  typeof ExternalOutpostConfigSolanaSchema
>

/**
 * The `create --external-outpost-config` input: the real-world deployed
 * addresses and public keys of outposts that already run on their own chains.
 *
 * The file is TRUSTED. `create` never checks it against a live endpoint and
 * never contacts either outpost: it starts no anvil or solana-test-validator,
 * deploys nothing, builds the operator daemons' ABI / IDL files from source
 * with these values overlaid, and gates success on the depot's head block and
 * queued outbound envelopes instead of epoch distribution.
 */
export const ExternalOutpostConfigSchema = z.strictObject({
  /** The Ethereum outpost. */
  ethereum: ExternalOutpostConfigEthereumSchema,
  /** The Solana outpost. */
  solana: ExternalOutpostConfigSolanaSchema
})
/** The `create --external-outpost-config` input — the shape of {@link ExternalOutpostConfigSchema}. */
export type ExternalOutpostConfig = z.infer<typeof ExternalOutpostConfigSchema>

/** Validated codec for the `--external-outpost-config` input file. */
export const ExternalOutpostConfigSchemaCodec =
  SchemaCodec.create<ExternalOutpostConfig>(ExternalOutpostConfigSchema)
