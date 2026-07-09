import {
  provisionStressWireAccountsWith,
  StressWireAccountFunding
} from "./real/realStressWireAccounts.js"
import { RealRamp, Timing } from "./real/realFlowConstants.js"
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
