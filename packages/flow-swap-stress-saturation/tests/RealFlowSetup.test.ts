import {
  provisionStressWireAccountsWith,
  StressWireAccountFunding
} from "./real/realStressWireAccounts.js"
import {
  RealRamp,
  Reserves,
  Timing,
  underwriterCollateral
} from "./real/realFlowConstants.js"
import { SwapStressPhaseAmounts } from "@wireio/test-flow-swap-stress-saturation"

describe("provisionStressWireAccountsWith", () => {
  it("provisions stress WIRE accounts sequentially to avoid ROA policy races", async () => {
    // Given: account provisioning records whether a later account starts before an earlier one settles.
    let activeProvisionCount = 0
    let overlapped = false

    // When: the stress setup provisions its generated WIRE accounts.
    await provisionStressWireAccountsWith(async () => {
      activeProvisionCount += 1
      overlapped = overlapped || activeProvisionCount > 1
      await Promise.resolve()
      activeProvisionCount -= 1
      return { account: "stressw11111", accountBytes: new Uint8Array() }
    })

    // Then: no provisioning call overlaps another one.
    expect(overlapped).toBe(false)
  })

  it("provisions the configured real-ramp account set", async () => {
    // Given: account provisioning records every generated WIRE stress account.
    const accounts: string[] = []

    // When: the real setup provisions all WIRE accounts the ramp may use.
    await provisionStressWireAccountsWith(async account => {
      accounts.push(account)
      return { account, accountBytes: new Uint8Array() }
    })

    // Then: setup matches the configured real saturation ramp capacity.
    expect(accounts).toHaveLength(RealRamp.Config.maxCount)
    expect(accounts.slice(0, RealRamp.BaselineCount)).toEqual([
      "stressw11111",
      "stressw11112",
      "stressw11113"
    ])
  })

  it("funds each stress WIRE account for every configured ramp iteration", () => {
    // Given: earliest stress accounts are reused by every ramp count.

    // When / Then: per-account funding covers the maximum reuse count.
    expect(StressWireAccountFunding).toBe(
      SwapStressPhaseAmounts.Phase2SourceWireUnits *
        BigInt(RealRamp.MaxIterationCount)
    )
  })

  it("funds ETH underwriter collateral for the configured phase-2 ramp", () => {
    // Given: phase 2 can remit to every configured account across every real-ramp iteration.
    const collateral = underwriterCollateral(),
      requiredEthCollateral =
        SwapStressPhaseAmounts.Phase2SourceWireUnits *
        BigInt(RealRamp.Config.maxCount) *
        BigInt(RealRamp.MaxIterationCount)

    // When: the real-flow ETH underwriter collateral entry is selected.
    const ethereum = collateral.find(
      entry =>
        entry.chain_code === Reserves.Ethereum.ChainCode &&
        entry.amount.tokenCode === BigInt(Reserves.Ethereum.TokenCode)
    )

    // Then: it can cover the configured phase-2 remit budget.
    expect(ethereum?.amount.amount).toBeGreaterThanOrEqual(
      requiredEthCollateral
    )
  })

  it("keeps Solana underwriter collateral within bootstrap funding", () => {
    // Given: Solana collateral is bootstrap-only for this ETH-targeted ramp.
    const collateral = underwriterCollateral()

    // When: both Solana collateral entries are selected.
    const solanaAmounts = collateral
      .filter(entry => entry.chain_code === Reserves.Solana.ChainCode)
      .map(entry => entry.amount.amount)

    // Then: neither entry inherits the larger ETH remit budget.
    expect(solanaAmounts).toEqual([1_000_000_000n, 1_000_000_000n])
  })

  it("budgets the real saturation ramp timeout as phaseTimeoutMs * MaxIterationCount plus BootstrapTimeoutMs", () => {
    // Given: the real ramp can consume its configured phase timeout across every iteration.
    const totalRampBudgetMs =
      RealRamp.Config.phaseTimeoutMs * RealRamp.MaxIterationCount

    // When: the named ramp timeout is compared against the configured ramp budget.
    // Then: it matches the configured formula and exceeds bootstrap alone.
    expect(Timing.RealSaturationRampTimeoutMs).toBe(
      totalRampBudgetMs + Timing.BootstrapTimeoutMs
    )
    expect(Timing.RealSaturationRampTimeoutMs).toBeGreaterThan(
      totalRampBudgetMs
    )
    expect(Timing.RealSaturationRampTimeoutMs).toBeGreaterThan(
      Timing.BootstrapTimeoutMs
    )
  })
})
