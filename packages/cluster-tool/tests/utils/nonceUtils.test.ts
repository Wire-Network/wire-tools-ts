import { Name } from "@wireio/sdk-core"
import { newSponsorNonce } from "@wireio/cluster-tool/utils"

/** Sample size for the distribution assertions — the roster ceiling is 26, so 1000 is ~40x. */
const SampleCount = 1_000
/** The exact shape a sponsor nonce must have: 12 characters, `[a-z1-5]` only. */
const SponsorNoncePattern = /^[a-z1-5]{12}$/

describe("nonceUtils", () => {
  describe("newSponsorNonce", () => {
    it("produces a 12-character nonce drawn only from [a-z1-5]", () => {
      expect(newSponsorNonce()).toMatch(SponsorNoncePattern)
    })

    it(`keeps every one of ${SampleCount} samples a valid WIRE name with no "."`, () => {
      const samples = Array.from({ length: SampleCount }, () => newSponsorNonce()),
        invalid = samples.filter(nonce => !Name.isValid(nonce)),
        dotted = samples.filter(nonce => nonce.includes(".")),
        misSized = samples.filter(nonce => nonce.length !== 12)
      expect(invalid).toEqual([])
      expect(dotted).toEqual([])
      expect(misSized).toEqual([])
    })

    it("round-trips every sample through Name.from without throwing", () => {
      Array.from({ length: 100 }, () => newSponsorNonce()).forEach(nonce =>
        expect(Name.from(nonce).toString()).toBe(nonce)
      )
    })

    it("is fresh on every call — two calls never collide", () => {
      expect(newSponsorNonce()).not.toBe(newSponsorNonce())
    })

    it("draws distinct values across a large sample (no constant / low-entropy generator)", () => {
      const samples = new Set(Array.from({ length: SampleCount }, () => newSponsorNonce()))
      expect(samples.size).toBe(SampleCount)
    })
  })
})
