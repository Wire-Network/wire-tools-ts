import {
  StressIdentityDefaults,
  createStressIdentities
} from "@wireio/test-flow-swap-stress-saturation"

import { StressIdentityFixtures } from "./constants.js"

describe("createStressIdentities", () => {
  it("returns stable unique ETH and SOL identities when count is positive", () => {
    // Given: a stress identity count large enough to prove uniqueness.
    const count = StressIdentityFixtures.Count

    // When: identities are generated twice from the deterministic seeds.
    const first = createStressIdentities(count)
    const second = createStressIdentities(count)

    // Then: every generated identity is stable, unique, and starts past operator slots.
    expect(first).toEqual(second)
    expect(first.ethereum.map(identity => identity.address)).toHaveLength(count)
    expect(new Set(first.ethereum.map(identity => identity.address)).size).toBe(
      count
    )
    expect(new Set(first.solana.map(identity => identity.publicKey)).size).toBe(
      count
    )
    expect(first.ethereum[0]?.hdIndex).toBe(
      StressIdentityDefaults.EthereumHdStartIndex
    )
    expect(
      first.ethereum.every(
        identity =>
          identity.hdIndex >= StressIdentityDefaults.OperatorReservedHdSlots
      )
    ).toBe(true)
  })

  it("returns SYSIO-valid WIRE account names when stress indexes use encoded digits", () => {
    // Given: enough stress identities to exercise encoded numeric digits.
    const count = 40,
      sysioAccountName = /^[.1-5a-z]{1,12}$/u

    // When: deterministic stress identities are created for real WIRE setup.
    const identities = createStressIdentities(count)

    // Then: every WIRE account is accepted by SYSIO account-name rules.
    expect(identities.wire.map(identity => identity.account)).toHaveLength(
      count
    )
    expect(
      new Set(identities.wire.map(identity => identity.account)).size
    ).toBe(count)
    expect(
      identities.wire.every(identity => sysioAccountName.test(identity.account))
    ).toBe(true)
    expect(identities.wire.map(identity => identity.account)).toContain(
      "stressw1111u"
    )
  })

  it("rejects count zero before deriving any identities", () => {
    // Given: the caller requests no stress identities.
    const count = 0

    // When/Then: the boundary rejects the invalid count assertively.
    expect(() => createStressIdentities(count)).toThrow(
      /stress identity count must be positive/
    )
  })
})
