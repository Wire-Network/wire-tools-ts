import type { ChainKind } from "@wireio/opp-typescript-models"
import {
  batchImportSeedCredits,
  mergeImportSeedCredits,
  type ImportSeedBatch,
  type ImportSeedChainKind,
  type ImportSeedCredit
} from "../../tools/wire/WireDclaimSeedTool.js"
import { outputKey, type OutputKey } from "../OutputStore.js"

/** Provenance categories for distribution-claim credit sets. */
export enum DistributionClaimBootstrapSource {
  ConfiguredFile = "configured-file",
  Synthetic = "synthetic",
  Controlled = "controlled"
}

/** One pre-batching credit set contributed for one native chain. */
export interface DistributionClaimBootstrapCreditSet {
  /** Native chain whose address and decimal conventions produced the credits. */
  readonly chain: ImportSeedChainKind
  /** Origin reported in preflight summaries. */
  readonly source: DistributionClaimBootstrapSource
  /** Converted WIRE-atomic credits. */
  readonly credits: readonly ImportSeedCredit[]
  /** Source-native dust discarded during decimal conversion. */
  readonly droppedDust: bigint
}

/**
 * Configured-file bootstrap state passed to an optional flow preparation hook.
 * Flow contributions are additive and never replace these credit sets.
 */
export interface DistributionClaimBootstrapCore {
  readonly creditSets: readonly DistributionClaimBootstrapCreditSet[]
}

/** Additive credit sets returned by a flow preparation hook. */
export interface DistributionClaimBootstrapContribution {
  readonly creditSets: readonly DistributionClaimBootstrapCreditSet[]
}

/** Final merged and transaction-batched import plan for one native chain. */
export interface DistributionClaimBootstrapChainResult {
  readonly chain: ImportSeedChainKind
  readonly sources: readonly DistributionClaimBootstrapSource[]
  readonly batches: readonly ImportSeedBatch[]
  readonly droppedDust: bigint
  readonly eligibleAddressCount: number
  readonly totalAtomic: bigint
}

/** Final generic distribution-claim import plan stored before phase composition. */
export interface DistributionClaimBootstrapResult {
  readonly chains: readonly DistributionClaimBootstrapChainResult[]
}

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
  contribution: DistributionClaimBootstrapContribution | null = null
): DistributionClaimBootstrapResult {
  const creditSets = [
    ...core.creditSets,
    ...(contribution?.creditSets ?? [])
  ].filter(creditSet => creditSet.credits.length > 0)
  const chains = [
    ...new Set(creditSets.map(creditSet => creditSet.chain))
  ].sort((left, right) => left - right)
  return {
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
  }
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
  for (const batch of chainResult.batches) {
    const credit = batch.credits.find(
      candidate => candidate.native_address === nativeAddress
    )
    if (credit != null) return credit.wire_atomic
  }
  return 0n
}
