import { encodeWireRecipient } from "@wireio/opp-stress-harness"

describe("encodeWireRecipient", () => {
  it("encodes a WIRE account name as its raw UTF-8 bytes in hex", () => {
    // Given/When: a WIRE account name is encoded for `targetRecipient`.
    const encoded = encodeWireRecipient("loadrecipient")

    // Then: it is the literal ASCII bytes (0x-prefixed), not a packed name.
    expect(encoded).toBe(
      `0x${Buffer.from("loadrecipient", "utf8").toString("hex")}`
    )
    expect(encoded).toBe("0x6c6f6164726563697069656e74")
  })

  it("round-trips back to the account name", () => {
    const name = "stressw11111"
    const bytes = Buffer.from(encodeWireRecipient(name).slice(2), "hex")
    expect(bytes.toString("utf8")).toBe(name)
  })
})
