import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  EndpointTypeNames,
  attestationCountFor,
  epochUpdatedAt,
  indexEnvelopesByEndpoint,
  isEpochComplete,
  totalAttestationsFor
} from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/util/EpochSummary.js"
import type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "@wire-e2e-tests/debugging-client-tool-tui/store/opp/OPPTypes.js"

function envelope(
  endpointsType: DebugOutpostEndpointsType,
  attestationCount: number,
  receivedAt = 0
): DebugOPPEnvelopeRecord {
  const messages = Array.from({ length: 1 }, () => ({
    payload: {
      version: 1,
      attestations: Array.from({ length: attestationCount }, () => ({
        type: 0,
        dataSize: 0,
        data: ""
      }))
    }
  }))
  return {
    checksum: "deadbeef",
    endpointsType,
    envelope: { messages } as never,
    metadata: { checksum: "0", batchOpNames: [] } as never,
    receivedAt
  }
}

describe("EndpointTypeNames", () => {
  it("includes the four real endpoints and excludes UNKNOWN / numeric reverse-map keys", () => {
    expect(EndpointTypeNames).toEqual(
      expect.arrayContaining([
        "OUTPOST_ETHEREUM_DEPOT",
        "OUTPOST_SOLANA_DEPOT",
        "DEPOT_OUTPOST_ETHEREUM",
        "DEPOT_OUTPOST_SOLANA"
      ])
    )
    expect(EndpointTypeNames).not.toContain("UNKNOWN")
    expect(EndpointTypeNames.every(n => Number.isNaN(Number(n)))).toBe(true)
  })
})

describe("attestationCountFor", () => {
  it("sums payload.attestations.length across every message", () => {
    const env = {
      messages: [
        { payload: { attestations: [{}, {}] } },
        { payload: { attestations: [{}] } }
      ]
    } as never
    expect(attestationCountFor(env)).toBe(3)
  })

  it("returns 0 for an undefined envelope", () => {
    expect(attestationCountFor(undefined)).toBe(0)
  })

  it("ignores messages without a payload", () => {
    const env = { messages: [{}, { payload: { attestations: [{}] } }] } as never
    expect(attestationCountFor(env)).toBe(1)
  })
})

describe("indexEnvelopesByEndpoint", () => {
  it("keys envelopes by their reverse-mapped endpoint name", () => {
    const epoch: DebugOPPEpochRecord = {
      epoch: 1,
      envelopes: [
        envelope(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, 2),
        envelope(DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA, 3)
      ]
    }
    const idx = indexEnvelopesByEndpoint(epoch)
    expect(idx.has("OUTPOST_ETHEREUM_DEPOT")).toBe(true)
    expect(idx.has("DEPOT_OUTPOST_SOLANA")).toBe(true)
    expect(idx.get("OUTPOST_ETHEREUM_DEPOT")?.endpointsType).toBe(
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    )
  })
})

describe("epochUpdatedAt", () => {
  it("returns the latest receivedAt across the epoch's envelopes", () => {
    const epoch: DebugOPPEpochRecord = {
      epoch: 1,
      envelopes: [
        envelope(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, 0, 1_000),
        envelope(DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT, 0, 2_500),
        envelope(DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM, 0, 1_750)
      ]
    }
    expect(epochUpdatedAt(epoch)).toBe(2_500)
  })

  it("returns null for an epoch with no envelopes", () => {
    expect(epochUpdatedAt({ epoch: 1, envelopes: [] })).toBeNull()
  })
})

describe("isEpochComplete", () => {
  it("requires every endpoint type to be present", () => {
    const partial: DebugOPPEpochRecord = {
      epoch: 1,
      envelopes: [
        envelope(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, 0)
      ]
    }
    expect(isEpochComplete(partial)).toBe(false)
  })

  it("returns true once every endpoint has an envelope", () => {
    const full: DebugOPPEpochRecord = {
      epoch: 1,
      envelopes: [
        envelope(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, 0),
        envelope(DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT, 0),
        envelope(DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM, 0),
        envelope(DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA, 0)
      ]
    }
    expect(isEpochComplete(full)).toBe(true)
  })
})

describe("totalAttestationsFor", () => {
  it("sums attestation counts across every envelope in the epoch", () => {
    const epoch: DebugOPPEpochRecord = {
      epoch: 1,
      envelopes: [
        envelope(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, 5),
        envelope(DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT, 3)
      ]
    }
    expect(totalAttestationsFor(epoch)).toBe(8)
  })
})
