import { z } from "zod"

import type { ChainKind } from "@wireio/opp-typescript-models"

import {
  batchImportSeedCredits,
  ImportSeedBatchSchema,
  ImportSeedChainKindSchema,
  ImportSeedCreditSchema,
  mergeImportSeedCredits,
  type ImportSeedChainKind
} from "../../tools/wire/WireDclaimSeedTool.js"
import { outputKey, type OutputKey } from "../OutputStore.js"

/** Provenance categories for distribution-claim credit sets. */
export enum DistributionClaimBootstrapSource {
  configuredFile = "configuredFile",
  synthetic = "synthetic",
  controlled = "controlled"
}

/** Runtime schema for a distribution-claim credit-set provenance category. */
export const DistributionClaimBootstrapSourceSchema = z.enum(
  DistributionClaimBootstrapSource
)

/** Runtime schema for one pre-batching credit set contributed for one native chain. */
export const DistributionClaimBootstrapCreditSetSchema = z.object({
  /** Native chain whose address and decimal conventions produced the credits. */
  chain: ImportSeedChainKindSchema,
  /** Origin reported in preflight summaries. */
  source: DistributionClaimBootstrapSourceSchema,
  /** Converted WIRE-atomic credits. */
  credits: z.array(ImportSeedCreditSchema),
  /** Source-native dust discarded during decimal conversion. */
  droppedDust: z.bigint().nonnegative()
})
/** One pre-batching credit set — the shape of {@link DistributionClaimBootstrapCreditSetSchema}. */
export type DistributionClaimBootstrapCreditSet = z.infer<
  typeof DistributionClaimBootstrapCreditSetSchema
>

/**
 * Runtime schema for configured-file bootstrap state passed to an optional
 * flow preparation hook. Flow contributions are additive and never replace
 * these credit sets.
 */
export const DistributionClaimBootstrapCoreSchema = z.object({
  creditSets: z.array(DistributionClaimBootstrapCreditSetSchema)
})
/** Configured-file bootstrap state — the shape of {@link DistributionClaimBootstrapCoreSchema}. */
export type DistributionClaimBootstrapCore = z.infer<
  typeof DistributionClaimBootstrapCoreSchema
>

/** Runtime schema for additive credit sets returned by a flow preparation hook. */
export const DistributionClaimBootstrapContributionSchema = z.object({
  creditSets: z.array(DistributionClaimBootstrapCreditSetSchema)
})
/** Additive flow credit sets — the shape of {@link DistributionClaimBootstrapContributionSchema}. */
export type DistributionClaimBootstrapContribution = z.infer<
  typeof DistributionClaimBootstrapContributionSchema
>

/** Runtime schema for the final merged import plan for one native chain. */
export const DistributionClaimBootstrapChainResultSchema = z.object({
  chain: ImportSeedChainKindSchema,
  sources: z.array(DistributionClaimBootstrapSourceSchema),
  batches: z.array(ImportSeedBatchSchema),
  droppedDust: z.bigint().nonnegative(),
  eligibleAddressCount: z.number().safe().int().nonnegative(),
  totalAtomic: z.bigint().nonnegative()
})
/** Final merged import plan for one native chain — the shape of {@link DistributionClaimBootstrapChainResultSchema}. */
export type DistributionClaimBootstrapChainResult = z.infer<
  typeof DistributionClaimBootstrapChainResultSchema
>

/** Runtime schema for the final generic distribution-claim import plan. */
export const DistributionClaimBootstrapResultSchema = z.object({
  chains: z.array(DistributionClaimBootstrapChainResultSchema)
})
/** Final generic import plan — the shape of {@link DistributionClaimBootstrapResultSchema}. */
export type DistributionClaimBootstrapResult = z.infer<
  typeof DistributionClaimBootstrapResultSchema
>

/**
 * Typed cross-step handle for the complete merged distribution-claim bootstrap
 * plan. Bulk credit arrays live here and are intentionally absent from Step
 * inputs and reports.
 */
export const DistributionClaimBootstrapResultKey: OutputKey<DistributionClaimBootstrapResult> =
  outputKey(
    "cluster.distributionClaimBootstrap",
    "merged and transaction-batched sysio.dclaim bootstrap credits"
  )

/**
 * Return whether configured bootstrap data exists for `chain`.
 *
 * @param core - Configured-file preparation result.
 * @param chain - Native chain to find.
 * @returns `true` when a configured-file credit set exists.
 */
export function hasDistributionClaimBootstrapChain(
  core: DistributionClaimBootstrapCore,
  chain: ImportSeedChainKind
): boolean {
  return core.creditSets.some(creditSet => creditSet.chain === chain)
}

/**
 * Merge core and flow contributions by chain/address, then batch only after the
 * merge so duplicate addresses cannot straddle independent action plans.
 *
 * @param core - Validated configured-file credit sets.
 * @param contribution - Optional additive flow credit sets.
 * @returns Deterministically chain/address-sorted action plan.
 */
export function finalizeDistributionClaimBootstrap(
  core: DistributionClaimBootstrapCore,
  contribution: DistributionClaimBootstrapContribution = null
): DistributionClaimBootstrapResult {
  const validatedCore = DistributionClaimBootstrapCoreSchema.parse(core),
    validatedContribution =
      contribution == null
        ? null
        : DistributionClaimBootstrapContributionSchema.parse(contribution),
    creditSets = [
      ...validatedCore.creditSets,
      ...(validatedContribution?.creditSets ?? [])
    ].filter(creditSet => creditSet.credits.length > 0),
    chains = [...new Set(creditSets.map(creditSet => creditSet.chain))].sort(
      (left, right) => left - right
    )
  return DistributionClaimBootstrapResultSchema.parse({
    chains: chains.map(chain => {
      const chainSets = creditSets.filter(
        creditSet => creditSet.chain === chain
      )
      const credits = mergeImportSeedCredits(
        chainSets.map(creditSet => creditSet.credits),
        chain
      )
      return {
        chain,
        sources: [
          ...new Set(chainSets.map(creditSet => creditSet.source))
        ].sort(),
        batches: batchImportSeedCredits(credits, { chain }),
        droppedDust: chainSets.reduce(
          (total, creditSet) => total + creditSet.droppedDust,
          0n
        ),
        eligibleAddressCount: credits.length,
        totalAtomic: credits.reduce(
          (total, credit) => total + credit.wire_atomic,
          0n
        )
      }
    })
  })
}

/**
 * Find one merged credit by native-address hex.
 *
 * @param result - Final merged bootstrap result.
 * @param chain - Native chain containing the address.
 * @param nativeAddress - Lowercase native-address hex without a prefix.
 * @returns The WIRE-atomic credit, or zero when absent.
 */
export function distributionClaimBootstrapCredit(
  result: DistributionClaimBootstrapResult,
  chain: ChainKind.EVM | ChainKind.SVM,
  nativeAddress: string
): bigint {
  const chainResult = result.chains.find(candidate => candidate.chain === chain)
  if (chainResult == null) return 0n
  return (
    chainResult.batches
      .flatMap(batch => batch.credits)
      .find(candidate => candidate.native_address === nativeAddress)
      ?.wire_atomic ?? 0n
  )
}
