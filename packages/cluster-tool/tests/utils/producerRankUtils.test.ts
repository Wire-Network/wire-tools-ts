import {
  ProducerTier,
  ProducerTierShift,
  producerTier
} from "@wireio/cluster-tool/utils"

/**
 * A `rank_score` packed the way the contract packs it — tier in the two high bits, the inverted
 * composite below — rendered the way the RPC renders a uint64.
 */
function packed(tier: ProducerTier, composite: bigint): string {
  return ((BigInt(tier) << ProducerTierShift) | composite).toString()
}

describe("producerRankUtils", () => {
  it("ProducerTier mirrors the contract's ascending schedule order", () => {
    expect(ProducerTier.healthy).toBe(0)
    expect(ProducerTier.bootstrapped).toBe(1)
    expect(ProducerTier.demoted).toBe(2)
    expect(ProducerTierShift).toBe(62n)
  })

  it("decodes the tier off the two high bits, whatever composite sits below", () => {
    expect(producerTier(packed(ProducerTier.healthy, 0n))).toBe(ProducerTier.healthy)
    expect(
      producerTier(packed(ProducerTier.healthy, (1n << ProducerTierShift) - 1n))
    ).toBe(ProducerTier.healthy)
    expect(producerTier(packed(ProducerTier.bootstrapped, 12_345n))).toBe(
      ProducerTier.bootstrapped
    )
    expect(producerTier(packed(ProducerTier.demoted, 0n))).toBe(ProducerTier.demoted)
  })

  it("accepts the RPC's number rendering as well as its string one", () => {
    expect(producerTier(0)).toBe(ProducerTier.healthy)
    expect(producerTier(12_345)).toBe(ProducerTier.healthy)
    expect(producerTier(packed(ProducerTier.demoted, 7n))).toBe(ProducerTier.demoted)
  })

  it("rejects a key carrying a tier the contract never packs", () => {
    expect(() => producerTier((3n << ProducerTierShift).toString())).toThrow(
      /unknown tier 3/
    )
  })
})
