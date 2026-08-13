import { SwapStressSaturationScenarioConstants as Constants } from "@wireio/test-flow-swap-stress-saturation/SwapStressSaturationScenarioConstants.js"
import { LoadProfile } from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"

const { Ramp, SwapAmounts, Underwriting } = Constants

/**
 * Total `(ETHEREUM, ETH)` lock demand of one campaign: every rung's swaps, on
 * every phase that draws the bucket. A lock is a wall-clock challenge window
 * that delivery never releases, so this is what the bond must cover when the
 * campaign runs shorter than the configured lock duration.
 */
const campaignLockDemand =
  SwapAmounts.Phase2SourceWireUnits *
  BigInt(Ramp.TotalPhaseSwaps) *
  Underwriting.EthereumLockingPhaseCount

/** The pre-fix sizing: the phase-2 draw against the curve's CEILING × rungs. */
function previousSizing(maxCount: number, rungCount: number): bigint {
  return (
    SwapAmounts.Phase2SourceWireUnits * BigInt(maxCount) * BigInt(rungCount)
  )
}

describe("Ramp.TotalPhaseSwaps", () => {
  it("sums the rung curve", () => {
    // Given: the ramp curve the campaign registers a Phase per.
    // Then: the total is its sum, not its ceiling.
    expect(Ramp.TotalPhaseSwaps).toBe(
      Ramp.RungAccountCounts.reduce((total, accountCount) => total + accountCount, 0)
    )
    expect(Ramp.TotalPhaseSwaps).toBeGreaterThan(0)
  })

  it("stays below the ceiling-times-rungs overestimate on a doubling curve", () => {
    // Given: every preset ramps by doubling, so the sum is strictly under the
    // ceiling repeated once per rung.
    expect(Ramp.TotalPhaseSwaps).toBeLessThan(
      Ramp.MaxCount * Ramp.MaxIterationCount
    )
  })
})

describe("Underwriting.EthereumCollateral", () => {
  it("covers both locking phases with minimum-bond headroom", () => {
    // Then: the bond is the whole campaign's lock demand plus the role minimum.
    expect(Underwriting.EthereumCollateral).toBe(
      campaignLockDemand + BigInt(Underwriting.MinimumBond)
    )
    expect(Underwriting.EthereumCollateral - campaignLockDemand).toBe(
      BigInt(Underwriting.MinimumBond)
    )
  })

  it("counts both phases — one phase's demand alone is not enough", () => {
    // Given: phase 1 locks its ETH source leg and phase 2 its ETH destination
    // leg, against the one opreg balance.
    const onePhaseDemand =
      SwapAmounts.Phase2SourceWireUnits * BigInt(Ramp.TotalPhaseSwaps)

    // Then: the bond is at least double a single phase's demand.
    expect(Underwriting.EthereumCollateral).toBeGreaterThan(onePhaseDemand * 2n)
  })

  it("under-bonds the campaign under the previous ceiling-based sizing", () => {
    // Given: a THREE-rung doubling curve — the shape where the pre-fix formula
    // (phase-2 only, ceiling × rungs) falls short rather than coincidentally
    // clearing demand by a few percent.
    const ramp = {
      initialCount: 48,
      multiplier: 2,
      maxCount: 192,
      phaseTimeoutMs: Ramp.PhaseTimeoutMs
    }
    const curve = LoadProfile.accountCurve(ramp),
      totalPhaseSwaps = curve.reduce(
        (total, accountCount) => total + accountCount,
        0
      ),
      demand =
        SwapAmounts.Phase2SourceWireUnits *
        BigInt(totalPhaseSwaps) *
        Underwriting.EthereumLockingPhaseCount

    // Then: the old formula leaves the campaign short; the new one covers it.
    expect(curve).toEqual([48, 96, 192])
    expect(previousSizing(ramp.maxCount, curve.length)).toBeLessThan(demand)
    expect(demand + BigInt(Underwriting.MinimumBond)).toBeGreaterThan(demand)
  })
})
