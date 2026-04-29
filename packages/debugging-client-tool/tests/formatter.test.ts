import {
  EnvelopeListEntry,
  DebugOutpostEndpointsType,
  GetEnvelopeResponse
} from "@wireio/opp-typescript-models"

import {
  formatList,
  formatInspect,
  OutputFormat
} from "@wireio/debugging-client-tool"

describe("formatList", () => {
  const entries: EnvelopeListEntry[] = [
    EnvelopeListEntry.create({
      key: "00000001-OUTPOST_ETHEREUM_DEPOT-abc123",
      epochIndex: 1,
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      checksum: "abc123",
      batchOpNames: ["batchop.a", "batchop.b"],
      timestamp: BigInt(1700000000000),
      dataSize: 256
    }),
    EnvelopeListEntry.create({
      key: "00000002-DEPOT_OUTPOST_SOLANA-def456",
      epochIndex: 2,
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      checksum: "def456",
      batchOpNames: ["batchop.a"],
      timestamp: BigInt(1700000060000),
      dataSize: 128
    })
  ]

  it("formats as plain text with header, separator, and rows", () => {
    const output = formatList(entries, OutputFormat.plain)
    const lines = output.split("\n")

    expect(lines.length).toBe(4) // header + separator + 2 rows
    expect(lines[0]).toContain("EPOCH")
    expect(lines[0]).toContain("ENDPOINTS")
    expect(lines[0]).toContain("CHECKSUM")
    expect(lines[0]).toContain("OPERATORS")
    expect(lines[2]).toContain("1")
    expect(lines[2]).toContain("abc123")
    expect(lines[3]).toContain("2")
    expect(lines[3]).toContain("def456")
  })

  it("formats as JSON with all fields", () => {
    const output = formatList(entries, OutputFormat.json)
    const parsed = JSON.parse(output)

    expect(parsed).toHaveLength(2)
    expect(parsed[0].key).toBe("00000001-OUTPOST_ETHEREUM_DEPOT-abc123")
    expect(parsed[0].epochIndex).toBe(1)
    expect(parsed[0].batchOpNames).toEqual(["batchop.a", "batchop.b"])
    expect(parsed[0]).toHaveProperty("timestampIso")
    expect(parsed[1].epochIndex).toBe(2)
  })

  it("returns 'No envelopes found.' for empty list in plain format", () => {
    const output = formatList([], OutputFormat.plain)
    expect(output).toBe("No envelopes found.")
  })

  it("returns empty JSON array for empty list in json format", () => {
    const output = formatList([], OutputFormat.json)
    expect(JSON.parse(output)).toEqual([])
  })
})

describe("formatInspect", () => {
  const resp = GetEnvelopeResponse.create({
    key: "00000042-OUTPOST_ETHEREUM_DEPOT-beef00",
    epochIndex: 42,
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    checksum: "beef00",
    batchOpNames: ["batchop.a"],
    timestamp: BigInt(1700000000000),
    dataSize: 64,
    envelopeData: new Uint8Array(0)
  })

  it("formats as plain text with key details", () => {
    const output = formatInspect(resp, OutputFormat.plain)
    expect(output).toContain("Key:")
    expect(output).toContain("00000042-OUTPOST_ETHEREUM_DEPOT-beef00")
    expect(output).toContain("Epoch:")
    expect(output).toContain("42")
    expect(output).toContain("Operators:")
    expect(output).toContain("batchop.a")
  })

  it("formats as JSON with all fields", () => {
    const output = formatInspect(resp, OutputFormat.json)
    const parsed = JSON.parse(output)
    expect(parsed.key).toBe("00000042-OUTPOST_ETHEREUM_DEPOT-beef00")
    expect(parsed.epochIndex).toBe(42)
    expect(parsed.batchOpNames).toEqual(["batchop.a"])
  })
})
