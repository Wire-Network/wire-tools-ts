import {
  EnvelopeDetailView,
  flattenAttestations
} from "@wireio/debugging-client-tool-tui/features/opp/panels/EnvelopeDetailView.js"

describe("flattenAttestations", () => {
  it("returns [] for an undefined envelope", () => {
    expect(flattenAttestations(undefined)).toEqual([])
  })

  it("concatenates payload.attestations across messages, in message order", () => {
    const env = {
      messages: [
        { payload: { attestations: [{ id: "a1" }, { id: "a2" }] } },
        { payload: { attestations: [{ id: "b1" }] } },
        { payload: undefined },
        { payload: { attestations: [{ id: "c1" }, { id: "c2" }] } }
      ]
    } as never
    expect(flattenAttestations(env).map((a: any) => a.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "c1",
      "c2"
    ])
  })
})

describe("EnvelopeDetailView", () => {
  it("declares its visual + JSON-rendering constants", () => {
    expect(EnvelopeDetailView.CursorMarker).toBe("›")
    expect(EnvelopeDetailView.JsonIndent).toBe(2)
    expect(EnvelopeDetailView.ExpansionIndent).toBeGreaterThan(0)
  })

  it("is a React function component", () => {
    expect(typeof EnvelopeDetailView).toBe("function")
  })
})
