import Assert from "node:assert"

import {
  WireSyndicationTool,
  EthereumSyndicationTool,
  SyndicationScenario,
  type ClusterBuildContext
} from "@wireio/cluster-tool"

import { EmergencyStopScenarioConstants as Constants } from "./EmergencyStopScenarioConstants.js"

/** Measurements used to create an Ethereum ratio-guard fixture, in depot units. */
export interface EthereumCustodySnapshot {
  custody: bigint
  outstanding: bigint
  redemption: bigint
  toleranceBps: bigint
}

/** Measured unbacked credit and the resulting post-redemption custody gap. */
export interface EthereumCustodyFixture extends EthereumCustodySnapshot {
  recredit: bigint
  gap: bigint
  postBurnOutstanding: bigint
}

/**
 * Measure the live pool allowance, custody, outstanding and net depot burn.
 * @param ctx - The build context used by the typed chain readers.
 * @param beyondAllowance - Whether to create a refused custody gap.
 * @returns The fixture derived from live reads, with the exact expected fee verified.
 */
export async function readEthereumCustodyFixture(
  ctx: ClusterBuildContext,
  beyondAllowance: boolean
): Promise<EthereumCustodyFixture> {
  const custody = await EthereumSyndicationTool.readPoolBalanceDepot(ctx),
    outstanding = await WireSyndicationTool.readOutstanding(
      ctx,
      Constants.EthereumToken
    ),
    toleranceBps = await EthereumSyndicationTool.readCustodyShortfallBps(ctx),
    quantity = SyndicationScenario.quantity(Constants.Payout).replace(
      SyndicationScenario.Token,
      Constants.EthereumToken
    ),
    fee = BigInt(await WireSyndicationTool.readDesyndicationFee(ctx, quantity)),
    redemption = Constants.Payout - fee
  Assert.strictEqual(redemption, Constants.EthereumRedemption)
  return createEthereumCustodyFixture(
    { custody, outstanding, redemption, toleranceBps },
    beyondAllowance
  )
}

/**
 * Size an unbacked credit against the pool's inclusive post-burn allowance.
 * Only the net redemption burns: fees remain outstanding on the depot. For
 * credit = custody - outstanding + gap, post-burn outstanding is
 * custody - redemption + gap. Solving the contract's exact product comparison
 * gives floor((custody - redemption) * bps / (10000 - bps)) as the last allowed gap.
 *
 * @param snapshot - Live custody, outstanding, net redemption and pool allowance.
 * @param beyondAllowance - Select a refused gap with a custody-drift margin, or an allowed gap at half the limit.
 * @returns The credit and projected post-burn state; no custody is withdrawn.
 */
export function createEthereumCustodyFixture(
  snapshot: EthereumCustodySnapshot,
  beyondAllowance: boolean
): EthereumCustodyFixture {
  const { custody, outstanding, redemption, toleranceBps } = snapshot,
    denominator = WireSyndicationTool.BasisPoints
  Assert.ok(
    toleranceBps >= 0n && toleranceBps < denominator,
    "invalid custody allowance"
  )
  Assert.ok(
    redemption > 0n && custody >= redemption,
    "payout must be fully funded"
  )
  Assert.ok(
    custody >= outstanding,
    "repair existing custody gap before measuring"
  )
  const maximumGap =
      ((custody - redemption) * toleranceBps) / (denominator - toleranceBps),
    gap = beyondAllowance
      ? maximumGap + 1n + Constants.EthereumCustodyMargin
      : maximumGap / 2n
  Assert.ok(
    gap > 0n,
    "allowance cannot accommodate a positive custody-gap fixture"
  )
  return {
    ...snapshot,
    gap,
    recredit: custody - outstanding + gap,
    postBurnOutstanding: custody - redemption + gap
  }
}

/**
 * Compare the exact widened products used by SyndicationPool's inclusive guard.
 * @param check - Actual post-payout custody, post-burn outstanding and allowance.
 * @returns Whether the remaining gap strictly exceeds the allowance.
 */
export function ethereumCustodyGapExceedsAllowance(
  check: EthereumSyndicationTool.CustodyCheck
): boolean {
  return (
    check.postPayoutBalanceDepot < check.totalSyndicated &&
    (check.totalSyndicated - check.postPayoutBalanceDepot) *
      WireSyndicationTool.BasisPoints >
      check.totalSyndicated * check.toleranceBps
  )
}
