import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import { z } from "zod"

import { TokenAmountCodec } from "../types/ChainTokenAmount.js"
import {
  EthereumNativeTokenCodename,
  SolanaNativeTokenCodename
} from "../types/nativeTokenCodenames.js"

/**
 * Companion constants of {@link BatchOperatorUnderwritingConfigSchema}: the
 * native amounts a pre-funded launch stakes and keeps per batch operator on
 * each outpost (`wire-cluster-tool fund-batch-operators`), in DEPOT units
 * (`NativeTokenDepotPrecision`, 9 decimals) of the outpost native token codes.
 * The schema defaults `stake` / `reserve` from these, so a persisted config
 * (or a build-options document) that omits them loads with these values.
 */
export namespace BatchOperatorUnderwritingConfig {
  /** Default Ethereum stake per operator — 1 ETH, in depot units. Changing it changes every launch's `Depositor.depositAndStake` value. */
  export const DefaultStakeEthereumUnits = 1_000_000_000n
  /** Default Solana stake per operator — 10 SOL, in depot units (lamports 1:1). Changing it changes every launch's `sol_to_liqsol` deposit. */
  export const DefaultStakeSolanaUnits = 10_000_000_000n
  /** Default Ethereum gas reserve each operator must keep beside its stake — 0.05 ETH, in depot units. */
  export const DefaultReserveEthereumUnits = 50_000_000n
  /** Default Solana fee + rent reserve each operator must keep beside its stake — 0.1 SOL, in depot units. */
  export const DefaultReserveSolanaUnits = 100_000_000n

  /**
   * A native `TokenAmount` — `units` of the depot token `codename` (packed as
   * the depot's `SlugName` code).
   *
   * @param codename - The native token codename (`ETH` / `SOL`).
   * @param units - The amount, in depot units.
   * @returns The amount.
   */
  export function nativeTokenAmount(codename: string, units: bigint): TokenAmount {
    return TokenAmount.create({
      tokenCode: BigInt(SlugName.from(codename)),
      amount: units
    })
  }

  /** The default per-operator stake on each outpost, in outpost order (ETH, SOL). */
  export const DefaultStake: readonly TokenAmount[] = [
    nativeTokenAmount(EthereumNativeTokenCodename, DefaultStakeEthereumUnits),
    nativeTokenAmount(SolanaNativeTokenCodename, DefaultStakeSolanaUnits)
  ]

  /** The default per-operator gas / fee reserve on each outpost, in outpost order (ETH, SOL). */
  export const DefaultReserve: readonly TokenAmount[] = [
    nativeTokenAmount(EthereumNativeTokenCodename, DefaultReserveEthereumUnits),
    nativeTokenAmount(SolanaNativeTokenCodename, DefaultReserveSolanaUnits)
  ]

  /**
   * A fresh copy of {@link DefaultStake} — what the schema default yields, so
   * no parsed config aliases the shared constant (a caller may mutate its own).
   *
   * @returns The default stake list.
   */
  export function defaultStake(): TokenAmount[] {
    return DefaultStake.map(amount => TokenAmount.clone(amount))
  }

  /**
   * A fresh copy of {@link DefaultReserve} — see {@link defaultStake}.
   *
   * @returns The default reserve list.
   */
  export function defaultReserve(): TokenAmount[] {
    return DefaultReserve.map(amount => TokenAmount.clone(amount))
  }
}

/**
 * How a cluster's batch operators run the `batch_operator_plugin` underwriter role — every
 * operator runs it, bonding from its own account. Persisted in `cluster-config.json`;
 * the member is `null` when the role is off.
 */
export const BatchOperatorUnderwritingConfigSchema = z.object({
  /**
   * How many bootstrap batch operators, in label order from `batchop.a`, the epoch-zero mock
   * import funds with both LIQSOL and LIQETH. The rest run the role holding nothing, so they never bond. Changing it
   * changes which operators can underwrite — and, for a pre-funded launch, how many
   * operators `fund-batch-operators` stakes on the outposts.
   */
  fundedOperatorCount: z.number().int().nonnegative(),
  /**
   * The `--batch-underwriter-max-exposure` caps every underwriting operator runs with, one
   * per shadow token: the most it may have bonded and unclaimed at once. A token without one
   * is not underwritten. At least one: an operator with no cap underwrites nothing.
   */
  maxExposure: z.array(TokenAmountCodec).min(1),
  /**
   * The NATIVE amount each pre-funded operator stakes on each outpost
   * (`fund-batch-operators`), one `TokenAmount` per outpost native token (`ETH`, `SOL`)
   * in depot units — the position the launch snapshot then carries for the operator.
   * Schema-defaulted from {@link BatchOperatorUnderwritingConfig.DefaultStake}, so a
   * config that omits it loads with the defaults; `.optional()` keeps the inferred
   * member optional (a config built in memory may omit it) while every parse fills it.
   */
  stake: z
    .array(TokenAmountCodec)
    .default(BatchOperatorUnderwritingConfig.defaultStake)
    .optional(),
  /**
   * The NATIVE amount each operator must KEEP on each outpost for gas / fees, one
   * `TokenAmount` per outpost native token in depot units: `fund-batch-operators`
   * refuses an operator whose balance is below `stake + reserve`. Schema-defaulted
   * from {@link BatchOperatorUnderwritingConfig.DefaultReserve}, same optionality rule
   * as `stake`.
   */
  reserve: z
    .array(TokenAmountCodec)
    .default(BatchOperatorUnderwritingConfig.defaultReserve)
    .optional()
})

/** The schema-inferred underwriting configuration of {@link BatchOperatorUnderwritingConfigSchema}. */
export type BatchOperatorUnderwritingConfig = z.infer<
  typeof BatchOperatorUnderwritingConfigSchema
>

/**
 * Caller options: every member optional; `ClusterConfigProvider.resolveBatchOperatorUnderwriting`
 * defaults `fundedOperatorCount` to every bootstrap batch operator and `maxExposure` to
 * `10.000000000 LIQSOL` and `10.000000000 LIQETH`; `stake` / `reserve` default from the
 * schema ({@link BatchOperatorUnderwritingConfig.DefaultStake} / `DefaultReserve`).
 */
export type BatchOperatorUnderwritingOptions =
  Partial<BatchOperatorUnderwritingConfig>
