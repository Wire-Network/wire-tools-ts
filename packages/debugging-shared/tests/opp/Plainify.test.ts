import { plainify } from "@wireio/debugging-shared"

describe("plainify", () => {
  it("preserves null and undefined", () => {
    expect(plainify(null)).toBeNull()
    expect(plainify(undefined)).toBeUndefined()
  })

  it("stringifies BigInt values", () => {
    expect(plainify(123n)).toBe("123")
  })

  it("base64-encodes Uint8Array", () => {
    expect(plainify(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("3q2+7w==")
  })

  it("base64-encodes a Buffer (Uint8Array subclass)", () => {
    expect(plainify(Buffer.from([0xde, 0xad]))).toBe("3q0=")
  })

  it("walks arrays", () => {
    expect(plainify([1n, new Uint8Array([0xff]), "x"])).toEqual([
      "1",
      "/w==",
      "x"
    ])
  })

  it("walks plain objects", () => {
    expect(
      plainify({
        a: 1n,
        b: { c: new Uint8Array([0x00]) },
        d: ["x", 2n]
      })
    ).toEqual({
      a: "1",
      b: { c: "AA==" },
      d: ["x", "2"]
    })
  })

  it("preserves primitives", () => {
    expect(plainify("hi")).toBe("hi")
    expect(plainify(42)).toBe(42)
    expect(plainify(true)).toBe(true)
  })
})
