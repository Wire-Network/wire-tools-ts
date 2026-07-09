import {
  ethereumPayoutObserver,
  wirePayoutObserver
} from "./real/realFlowPayoutObservers.js"
import type { SwapStressPayoutObservationRequest } from "@wireio/test-flow-swap-stress-saturation"

describe("real flow payout observers", () => {
  it("reads WIRE payout balances sequentially", async () => {
    // Given: a WIRE balance reader that records overlapping RPC calls.
    const tracker = overlapTracker()
    const client = {
      getWireBalance: async (account: string) => tracker.read(account)
    }
    const observer = wirePayoutObserver(client)

    // When: baselines and payout observations are collected.
    const request = payoutRequest()
    await observer.preparePayouts?.(request)
    const observed = await observer.waitForPayouts(request)

    // Then: balance reads never overlap while the payout is still observed.
    expect(tracker.overlapped()).toBe(false)
    expect(observed.observedCount).toBe(2)
  })

  it("reads Ethereum payout balances sequentially", async () => {
    // Given: an Ethereum balance reader that records overlapping RPC calls.
    const tracker = overlapTracker()
    const provider = {
      getBalance: async (address: string) => tracker.read(address)
    }
    const observer = ethereumPayoutObserver(provider)

    // When: baselines and payout observations are collected.
    const request = payoutRequest()
    await observer.preparePayouts?.(request)
    const observed = await observer.waitForPayouts(request)

    // Then: balance reads never overlap while the payout is still observed.
    expect(tracker.overlapped()).toBe(false)
    expect(observed.observedCount).toBe(2)
  })
})

function payoutRequest(): SwapStressPayoutObservationRequest {
  return {
    phase: "phase-2",
    expectedCount: 2,
    minimumObservedCount: 1,
    targetAmount: 10n,
    targets: [
      { index: 0, address: "acct0" },
      { index: 1, address: "acct1" }
    ]
  }
}

function overlapTracker(): {
  readonly read: (address: string) => Promise<bigint>
  readonly overlapped: () => boolean
} {
  const calls = new Map<string, number>()
  let activeReads = 0
  let sawOverlap = false

  return {
    read: async address => {
      activeReads += 1
      sawOverlap = sawOverlap || activeReads > 1
      await Promise.resolve()
      activeReads -= 1
      const previousCalls = calls.get(address) ?? 0
      calls.set(address, previousCalls + 1)
      return previousCalls === 0 ? 0n : 10n
    },
    overlapped: () => sawOverlap
  }
}
