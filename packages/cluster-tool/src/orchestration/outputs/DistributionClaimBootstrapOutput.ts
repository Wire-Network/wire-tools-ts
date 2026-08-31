import { z } from "zod"

import { ChainKind } from "@wireio/opp-typescript-models"

import {
  DistributionClaimBootstrapSource,
  type DistributionClaimBootstrapCreditSet,
  type DistributionClaimBootstrapInputCreditSet,
  type DistributionClaimBootstrapOptions
} from "../../types/DistributionClaimBootstrap.js"
import {
  batchImportSeedCredits,
  ImportSeedBatchSchema,
  ImportSeedChainKindSchema,
  ImportSeedCreditSetSchema,
  mergeImportSeedCredits,
  type ImportSeedChainKind
} from "../../tools/wire/WireDclaimSeedTool.js"

export {
  DistributionClaimBootstrapSource,
  type DistributionClaimBootstrapCreditSet,
  type DistributionClaimBootstrapOptions
} from "../../types/DistributionClaimBootstrap.js"

/** Runtime schema for a distribution-claim credit-set provenance category. */
export const DistributionClaimBootstrapSourceSchema = z.enum(
  DistributionClaimBootstrapSource
)

/** Runtime schema for one pre-batching credit set from one native chain. */
export const DistributionClaimBootstrapCreditSetSchema: z.ZodType<DistributionClaimBootstrapCreditSet> =
  ImportSeedCreditSetSchema.safeExtend({
    source: DistributionClaimBootstrapSourceSchema,
    droppedDust: z.bigint().nonnegative()
  })

/** Runtime schema for one batch with its deterministic global row identity. */
export const DistributionClaimBootstrapBatchSchema =
  ImportSeedBatchSchema.safeExtend({
    batchIndex: z.number().safe().int().nonnegative(),
    firstUnmappedId: z.bigint().positive()
  })
/** One batch with its deterministic index and first global dclaim row id. */
export type DistributionClaimBootstrapBatch = z.infer<
  typeof DistributionClaimBootstrapBatchSchema
>

/** Runtime schema for the finalized import plan for one native chain. */
export const DistributionClaimBootstrapChainResultSchema = z.object({
  chain: ImportSeedChainKindSchema,
  sources: z.array(DistributionClaimBootstrapSourceSchema),
  batches: z.array(DistributionClaimBootstrapBatchSchema),
  droppedDust: z.bigint().nonnegative(),
  eligibleAddressCount: z.number().safe().int().positive(),
  totalAtomic: z.bigint().positive()
})
/** Finalized import plan and compact summary for one native chain. */
export type DistributionClaimBootstrapChainResult = z.infer<
  typeof DistributionClaimBootstrapChainResultSchema
>

/** Runtime schema for a deterministic distribution-claim bootstrap plan. */
export const DistributionClaimBootstrapResultSchema = z.object({
  chains: z.array(DistributionClaimBootstrapChainResultSchema)
})
/** Deterministic distribution-claim bootstrap plan for every selected chain. */
export type DistributionClaimBootstrapResult = z.infer<
  typeof DistributionClaimBootstrapResultSchema
>

/** Stable source order used in compact summaries. */
const DistributionClaimBootstrapSourceOrder = [
  DistributionClaimBootstrapSource.configuredFile,
  DistributionClaimBootstrapSource.fallback,
  DistributionClaimBootstrapSource.additive
] as const

/**
 * Select configured or fallback inputs per chain, merge additive credits,
 * sort and batch once, and assign globally deterministic dclaim row ids.
 *
 * @param options - Generic configured, fallback, and additive credit inputs.
 * @returns A deterministic plan; no inputs produce an empty plan.
 */
export function createDistributionClaimBootstrapPlan(
  options: DistributionClaimBootstrapOptions = {}
): DistributionClaimBootstrapResult {
  const {
      configuredCreditSets = [],
      fallbackCreditSets = [],
      additiveCreditSets = [],
      batchSize
    } = options,
    configured = toCreditSets(
      configuredCreditSets,
      DistributionClaimBootstrapSource.configuredFile
    ),
    fallback = toCreditSets(
      fallbackCreditSets,
      DistributionClaimBootstrapSource.fallback
    ),
    additive = toCreditSets(
      additiveCreditSets,
      DistributionClaimBootstrapSource.additive
    ),
    chains = [ChainKind.EVM, ChainKind.SVM] as const
  let nextUnmappedId = 1n

  const results = chains.flatMap(chain => {
    const configuredForChain = configured.filter(set => set.chain === chain),
      fallbackForChain = fallback.filter(set => set.chain === chain),
      additiveForChain = additive.filter(set => set.chain === chain),
      selectedBase =
        configuredForChain.length > 0 ? configuredForChain : fallbackForChain,
      selectedSets = [...selectedBase, ...additiveForChain],
      creditSets = selectedSets.filter(set => set.credits.length > 0)
    if (creditSets.length === 0) return []

    const credits = mergeImportSeedCredits(
        creditSets.map(set => set.credits),
        chain
      ),
      batches = batchImportSeedCredits(credits, { chain, batchSize }).map(
        (batch, batchIndex) => {
          const plannedBatch: DistributionClaimBootstrapBatch = {
            ...batch,
            batchIndex,
            firstUnmappedId: nextUnmappedId
          }
          nextUnmappedId += BigInt(batch.credits.length)
          return plannedBatch
        }
      ),
      sources = [...new Set(selectedSets.map(set => set.source))].sort(
        (left, right) =>
          DistributionClaimBootstrapSourceOrder.indexOf(left) -
          DistributionClaimBootstrapSourceOrder.indexOf(right)
      )

    return [
      {
        chain,
        sources,
        batches,
        droppedDust: selectedSets.reduce(
          (total, set) => total + set.droppedDust,
          0n
        ),
        eligibleAddressCount: credits.length,
        totalAtomic: credits.reduce(
          (total, credit) => total + credit.wire_atomic,
          0n
        )
      }
    ]
  })
  return DistributionClaimBootstrapResultSchema.parse({ chains: results })
}

/**
 * Return whether configured bootstrap credits exist for a native chain.
 *
 * @param options - Bootstrap planning inputs.
 * @param chain - Native chain to inspect.
 * @returns Whether a configured credit set exists for the chain.
 */
export function hasConfiguredDistributionClaimBootstrapChain(
  options: DistributionClaimBootstrapOptions,
  chain: ImportSeedChainKind
): boolean {
  return (options.configuredCreditSets ?? []).some(set => set.chain === chain)
}

/**
 * Find one final merged credit by native-address hex.
 *
 * @param result - Final bootstrap plan.
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

function toCreditSets(
  inputs: readonly DistributionClaimBootstrapInputCreditSet[],
  source: DistributionClaimBootstrapSource
): DistributionClaimBootstrapCreditSet[] {
  return inputs.map(input =>
    DistributionClaimBootstrapCreditSetSchema.parse({ ...input, source })
  )
}
