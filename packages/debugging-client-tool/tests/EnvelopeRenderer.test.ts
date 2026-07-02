import { Envelope } from "@wireio/opp-typescript-models"
import { EnvelopeRenderer } from "@wireio/debugging-client-tool"

function envelopeBytes(epochIndex: number): Uint8Array {
  return Envelope.toBinary(
    Envelope.create({
      epochIndex,
      epochTimestamp: BigInt(0),
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      messages: []
    })
  )
}

describe("EnvelopeRenderer", () => {
  it("renders the decoded envelope header for valid bytes", () => {
    const rendered = new EnvelopeRenderer(envelopeBytes(7)).render()
    expect(rendered).toContain("--- Envelope Contents ---")
    expect(rendered).toMatch(/Epoch Index:\s+7/)
    expect(rendered).toMatch(/Messages:\s+0/)
  })

  it("renders a decode-failure line for undecodable bytes", () => {
    // field 1, wire type 2 (LEN), length 255, but no bytes follow → premature EOF
    const rendered = new EnvelopeRenderer(new Uint8Array([0x0a, 0xff])).render()
    expect(rendered).toMatch(/Envelope decode failed/)
  })
})
