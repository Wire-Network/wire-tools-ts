import {
  ProducerCompositeBits,
  ProducerRegistrationOrderBits,
  ProducerTier,
  ProducerTierShift,
  producerTier
} from "@wireio/cluster-tool/utils"

/** The largest composite the key holds — the contract's `composite_max`. */
const CompositeMax = (1n << ProducerCompositeBits) - 1n

/** The largest registration order the key holds — the contract's `registration_max`. */
const RegistrationOrderMax = (1n << ProducerRegistrationOrderBits) - 1n

/**
 * A `rank_score` packed the way the contract's `producer_rank::pack` packs it — tier in the two
 * high bits, the INVERTED composite below it, the registration order in the low bits — rendered
 * the way the RPC renders a uint64.
 */
function packed(
  tier: ProducerTier,
  composite: bigint,
  registrationOrder: bigint
): string {
  return (
    (BigInt(tier) << ProducerTierShift) |
    ((CompositeMax - composite) << ProducerRegistrationOrderBits) |
    registrationOrder
  ).toString()
}

describe("producerRankUtils", () => {
  it("ProducerTier mirrors the contract's ascending schedule order", () => {
    expect(ProducerTier.healthy).toBe(0)
    expect(ProducerTier.bootstrapped).toBe(1)
    expect(ProducerTier.demoted).toBe(2)
  })

  it("mirrors the contract's key layout: 2 tier bits over a 40-bit composite and a 22-bit registration order", () => {
    expect(ProducerCompositeBits).toBe(40n)
    expect(ProducerRegistrationOrderBits).toBe(22n)
    expect(ProducerTierShift).toBe(62n)
  })

  it("decodes the tier off the two high bits, whatever composite and registration order sit below", () => {
    expect(producerTier(packed(ProducerTier.healthy, 0n, 1n))).toBe(ProducerTier.healthy)
    expect(
      producerTier(packed(ProducerTier.healthy, 0n, RegistrationOrderMax))
    ).toBe(ProducerTier.healthy)
    expect(producerTier(packed(ProducerTier.healthy, CompositeMax, 0n))).toBe(
      ProducerTier.healthy
    )
    expect(producerTier(packed(ProducerTier.bootstrapped, 12_345n, 7n))).toBe(
      ProducerTier.bootstrapped
    )
    expect(producerTier(packed(ProducerTier.demoted, CompositeMax, 1n))).toBe(
      ProducerTier.demoted
    )
  })

  it("accepts the RPC's number rendering as well as its string one", () => {
    expect(producerTier(0)).toBe(ProducerTier.healthy)
    expect(producerTier(12_345)).toBe(ProducerTier.healthy)
    expect(producerTier(packed(ProducerTier.demoted, 7n, 1n))).toBe(ProducerTier.demoted)
  })

  it("rejects a key carrying a tier the contract never packs", () => {
    expect(() => producerTier((3n << ProducerTierShift).toString())).toThrow(
      /unknown tier 3/
    )
  })

  it("refuses a tiered key rendered as a number, rather than decoding a rounded one", () => {
    // unscored() -- pack(demoted, 0, 0): the worst composite, and an unassigned registration
    // order encoded as the largest one. The value every unrankable row carries.
    const unscored = (BigInt(ProducerTier.demoted) << ProducerTierShift) | ((1n << ProducerTierShift) - 1n)
    expect(packed(ProducerTier.demoted, 0n, RegistrationOrderMax)).toBe(unscored.toString())
    expect(producerTier(unscored.toString())).toBe(ProducerTier.demoted)

    // The same value as a double is not representable: it rounds UP past the tier boundary, so
    // decoding it would silently report a tier the contract never packs.
    expect(Number(unscored)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
    expect(() => producerTier(Number(unscored))).toThrow(/must arrive as a string/)
  })

  it("still accepts a healthy-tier key as a number, where a double is exact", () => {
    expect(producerTier(Number.MAX_SAFE_INTEGER)).toBe(ProducerTier.healthy)
  })
})
