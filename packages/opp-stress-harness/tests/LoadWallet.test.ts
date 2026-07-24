import {
  createLoadWalletKeys,
  formatWireAsset,
  nonceForIndex,
  parseWireAsset,
  toRecipientHex
} from "@wireio/opp-stress-harness"

describe("createLoadWalletKeys", () => {
  it("generates the requested count with matched destinations", () => {
    // Given/When: three wallets are generated.
    const wallets = createLoadWalletKeys(3)

    // Then: each carries K1 key material and its own EVM destination.
    expect(wallets).toHaveLength(3)
    wallets.forEach((wallet, index) => {
      expect(wallet.index).toBe(index)
      expect(wallet.publicKey.startsWith("PUB_K1_")).toBe(true)
      expect(wallet.privateKey.length).toBeGreaterThan(0)
      expect(wallet.destination.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(wallet.destination.privateKey.length).toBeGreaterThan(0)
    })
  })

  it("generates distinct keys and destinations per wallet", () => {
    // Given/When: a set of wallets.
    const wallets = createLoadWalletKeys(5)

    // Then: no key or destination repeats.
    expect(new Set(wallets.map(w => w.privateKey)).size).toBe(5)
    expect(new Set(wallets.map(w => w.destination.address)).size).toBe(5)
  })

  it("rejects a non-positive count", () => {
    expect(() => createLoadWalletKeys(0)).toThrow(/positive integer/)
    expect(() => createLoadWalletKeys(1.5)).toThrow(/positive integer/)
  })
})

describe("WIRE asset conversion", () => {
  it("formats base units as a 9-decimal asset string", () => {
    expect(formatWireAsset(100_000_000n)).toBe("0.100000000 WIRE")
    expect(formatWireAsset(0n)).toBe("0.000000000 WIRE")
    expect(formatWireAsset(2_500_000_000n)).toBe("2.500000000 WIRE")
  })

  it("round-trips through parseWireAsset", () => {
    const amounts = [0n, 1n, 100_000_000n, 2_500_000_000n, 987_654_321_012n]
    amounts.forEach(amount =>
      expect(parseWireAsset(formatWireAsset(amount))).toBe(amount)
    )
  })

  it("rejects a negative amount", () => {
    expect(() => formatWireAsset(-1n)).toThrow(/must not be negative/)
  })
})

describe("nonceForIndex", () => {
  it("derives distinct name-safe nonces per index", () => {
    const nonces = Array.from({ length: 64 }, (_u, index) =>
      nonceForIndex("ld", index)
    )
    expect(new Set(nonces).size).toBe(64)
    nonces.forEach(nonce => expect(nonce).toMatch(/^[a-z1-5.]{1,12}$/))
  })

  it("is deterministic for the same prefix and index", () => {
    expect(nonceForIndex("ld", 41)).toBe(nonceForIndex("ld", 41))
    expect(nonceForIndex("ld", 41)).not.toBe(nonceForIndex("lx", 41))
  })

  it("rejects a derived nonce longer than a WIRE name", () => {
    expect(() => nonceForIndex("abcdefghijkl", 0)).toThrow(/exceeds 12 chars/)
  })
})

describe("toRecipientHex", () => {
  it("strips the 0x prefix and lowercases", () => {
    expect(toRecipientHex("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01")).toBe(
      "abcdef0123456789abcdef0123456789abcdef01"
    )
  })
})
