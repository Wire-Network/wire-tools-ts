import {
  EvmAddressPattern,
  EvmCompressedPublicKeyPattern,
  SolanaAddressPattern
} from "@wireio/cluster-tool-shared"

/** The secp256k1 generator point, compressed — a valid even-parity key. */
const GeneratorPublicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

describe("chainAddressPatterns", () => {
  it("EvmAddressPattern accepts a 0x + 40 hex address in any letter case", () => {
    expect(EvmAddressPattern.test("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).toBe(true)
    expect(EvmAddressPattern.test("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc")).toBe(true)
  })

  it("EvmAddressPattern rejects a missing prefix, a wrong length, and non-hex characters", () => {
    expect(EvmAddressPattern.test("9965507D1a55bcC2695C58ba16FB37d819B0A4dc")).toBe(false)
    expect(EvmAddressPattern.test("0x9965507D1a55bcC2695C58ba16FB37d819B0A4")).toBe(false)
    expect(EvmAddressPattern.test("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dcZZ")).toBe(false)
    expect(EvmAddressPattern.test("0xZZ65507D1a55bcC2695C58ba16FB37d819B0A4dc")).toBe(false)
  })

  it("SolanaAddressPattern accepts a base58 32-byte public key", () => {
    expect(SolanaAddressPattern.test("11111111111111111111111111111111")).toBe(true)
    expect(SolanaAddressPattern.test("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe(true)
  })

  it("SolanaAddressPattern rejects non-base58 characters and out-of-range lengths", () => {
    expect(SolanaAddressPattern.test("0OIl1111111111111111111111111111")).toBe(false)
    expect(SolanaAddressPattern.test("1111111111111111111111111111111")).toBe(false)
    expect(SolanaAddressPattern.test("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsUx")).toBe(false)
  })

  it("EvmCompressedPublicKeyPattern accepts a 02/03-prefixed 33-byte key, with or without 0x", () => {
    expect(EvmCompressedPublicKeyPattern.test(GeneratorPublicKey)).toBe(true)
    expect(EvmCompressedPublicKeyPattern.test(`0x${GeneratorPublicKey}`)).toBe(true)
    expect(
      EvmCompressedPublicKeyPattern.test(`03${GeneratorPublicKey.slice(2)}`)
    ).toBe(true)
  })

  it("EvmCompressedPublicKeyPattern rejects a bad parity prefix, a 20-byte address and a short key", () => {
    expect(
      EvmCompressedPublicKeyPattern.test(`04${GeneratorPublicKey.slice(2)}`)
    ).toBe(false)
    expect(
      EvmCompressedPublicKeyPattern.test("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc")
    ).toBe(false)
    expect(
      EvmCompressedPublicKeyPattern.test(GeneratorPublicKey.slice(0, -2))
    ).toBe(false)
  })
})
