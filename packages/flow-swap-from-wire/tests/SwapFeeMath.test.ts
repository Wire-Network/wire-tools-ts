import { WIREClient } from "@wireio/test-cluster-tool"

/**
 * Fast static-vector coverage for `WIREClient.splitWireFee` — the TypeScript
 * mirror of `sysio::opp::amm::split_wire_fee`. This runs with the swap-flow
 * suite (no cluster) and pins the fee kernel against fixed vectors; the live
 * SwapFromWire scenario in this package is the end-to-end check, asserting the
 * depot's actual post-fee reserve books equal `splitWireFee(...)`. The
 * exact-integer relationships (`reward + emissions === fee`,
 * `net + fee === wireAmount`) are the invariants every swap flow relies on to
 * predict reserve movement, so they're asserted directly here too.
 */
describe("WIREClient.splitWireFee", () => {
  test("defaults to the dev-cluster fee (0.1%) and 50/50 reward split", () => {
    // 99_009_900 is the Phase-A ETH→SOL weighted intermediate from the swap
    // flows; the contract floors fee to 99_009 and credits net 98_910_891.
    const fee = WIREClient.splitWireFee(99_009_900n)
    expect(fee.fee).toBe(99_009n)
    expect(fee.net).toBe(98_910_891n)
    expect(fee.rewardShare).toBe(49_504n)
    expect(fee.emissionsShare).toBe(49_505n)
  })

  test("preserves the exact-integer invariants (no rounding leak)", () => {
    const amounts = [
      1n,
      7n,
      1_000_000n,
      99_009_900n,
      100_969_310n,
      80_000_000_000n
    ]
    amounts.forEach(amount => {
      const fee = WIREClient.splitWireFee(amount)
      expect(fee.rewardShare + fee.emissionsShare).toBe(fee.fee)
      expect(fee.net + fee.fee).toBe(amount)
    })
  })

  test("floors the fee toward zero", () => {
    // 5_000 * 10 / 10000 = 5 exactly; 5_001 * 10 / 10000 = 5.001 → floored to 5.
    expect(WIREClient.splitWireFee(5_000n).fee).toBe(5n)
    expect(WIREClient.splitWireFee(5_001n).fee).toBe(5n)
  })

  test("honors an explicit fee and reward share", () => {
    // 1% fee, 100% reward share → nothing leaves custody.
    const fee = WIREClient.splitWireFee(1_000_000n, 100, WIREClient.BpsTotal)
    expect(fee.fee).toBe(10_000n)
    expect(fee.rewardShare).toBe(10_000n)
    expect(fee.emissionsShare).toBe(0n)
    expect(fee.net).toBe(990_000n)
  })

  test("clamps out-of-range bps to [0, 10000]", () => {
    // Negative bps floors to 0 (no fee); >100% caps at the full amount.
    expect(WIREClient.splitWireFee(1_000n, -5).fee).toBe(0n)
    expect(WIREClient.splitWireFee(1_000n, 20_000).fee).toBe(1_000n)
  })

  test("a zero amount yields all-zero shares", () => {
    const fee = WIREClient.splitWireFee(0n)
    expect(fee.fee).toBe(0n)
    expect(fee.net).toBe(0n)
    expect(fee.rewardShare).toBe(0n)
    expect(fee.emissionsShare).toBe(0n)
  })
})
