import { createEnvelopeBaseline } from "@wireio/debugging-shared"

describe("createEnvelopeBaseline", () => {
  it("hashes the sorted unique UTF-8 JSON key list", () => {
    // Given: duplicate keys in noncanonical order.
    const keys = ["beta", "alpha", "beta"]

    // When: the public baseline constructor canonicalizes them.
    const baseline = createEnvelopeBaseline(keys)

    // Then: the keys and content identity follow the exact baseline contract.
    expect(baseline).toEqual({
      identity:
        "sha256:138bf4722f7ae17122c7282d0eb156499d349940e129bd4cdf27c8ffdcbb3d25",
      baseKeys: ["alpha", "beta"]
    })
  })

  it("returns the canonical empty baseline identity", () => {
    // Given: no pre-phase sidecar keys.
    // When: the canonical empty baseline is constructed.
    const baseline = createEnvelopeBaseline([])

    // Then: it hashes the exact JSON array rather than inventing an identity.
    expect(baseline).toEqual({
      identity:
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      baseKeys: []
    })
  })
})
