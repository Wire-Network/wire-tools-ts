import {
  OppProtocolCapabilities,
  OppProtocolCapabilitiesSchemaCodec,
  OppProtocolManifestSchemaCodec
} from "@wireio/cluster-tool-shared"

describe("OPP protocol capabilities", () => {
  it("preserves the current V1 release matrix", () => {
    expect(OppProtocolManifestSchemaCodec.deserialize(
      OppProtocolManifestSchemaCodec.serialize(OppProtocolCapabilities.CurrentManifest)
    )).toEqual({
      schemaVersion: 1,
      depot: { emit: [1], receive: [1] },
      ethereum: { emit: [1], receive: [1] },
      solana: { emit: [1], receive: [1] }
    })
  })

  it.each([[], [0], [2.5], [128], [129], [0xffff_ffff], [1, 1]].map(versions => ({ versions })))(
    "rejects malformed version sets $versions", ({ versions }) => {
      expect(OppProtocolCapabilitiesSchemaCodec.check({ emit: versions, receive: [1] })).toBe(false)
      expect(OppProtocolCapabilitiesSchemaCodec.check({ emit: [1], receive: versions })).toBe(false)
    }
  )

  it("requires explicit declarations", () => {
    expect(OppProtocolCapabilitiesSchemaCodec.check({})).toBe(false)
    expect(() => OppProtocolCapabilities.assertCompatible(null, OppProtocolCapabilities.Current, "test"))
      .toThrow("missing or malformed")
  })

  it("permits receiver-first expansion while all emitters stay on V1", () => {
    const expanded = { emit: [1], receive: [1, 2] }
    expect(() => OppProtocolCapabilities.assertCompatible(OppProtocolCapabilities.Current, expanded, "forward"))
      .not.toThrow()
    expect(() => OppProtocolCapabilities.assertCompatible(expanded, OppProtocolCapabilities.Current, "reverse"))
      .not.toThrow()
  })

  it("checks every emitted version, not just a shared version", () => {
    expect(() => OppProtocolCapabilities.assertCompatible(
      { emit: [1, 2], receive: [1] }, OppProtocolCapabilities.Current, "outpost -> depot"
    )).toThrow("outpost -> depot: 2")
    expect(() => OppProtocolCapabilities.assertCompatible(
      OppProtocolCapabilities.Current, { emit: [1], receive: [2] }, "depot -> outpost"
    )).toThrow("depot -> outpost: 1")
  })
})
