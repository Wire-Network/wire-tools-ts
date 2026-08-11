import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  parseEnvelopeStorageKey,
  resolveEndpointsType
} from "@wireio/debugging-shared"

describe("parseEnvelopeStorageKey", () => {
  it("decomposes a well-formed key", () => {
    const parsed = parseEnvelopeStorageKey(
      "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890"
    )
    expect(parsed).toEqual({
      key: "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890",
      epochIndex: 42,
      endpointsKey: "OUTPOST_ETHEREUM_DEPOT",
      checksum: "abc123def4567890"
    })
  })

  it("returns null when there's no first dash", () => {
    expect(parseEnvelopeStorageKey("garbage")).toBeNull()
  })

  it("returns null when the second dash is missing", () => {
    expect(parseEnvelopeStorageKey("00000042-OUTPOST")).toBeNull()
  })

  it("returns null when the epoch prefix is non-numeric", () => {
    expect(
      parseEnvelopeStorageKey("epoch-OUTPOST_ETHEREUM_DEPOT-checksum")
    ).toBeNull()
  })
})

describe("resolveEndpointsType", () => {
  it("returns the matching enum variant", () => {
    expect(resolveEndpointsType("OUTPOST_ETHEREUM_DEPOT")).toBe(
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    )
  })

  it("falls back to UNKNOWN for an unrecognized name", () => {
    expect(resolveEndpointsType("ZZZ_NEVER_HEARD_OF_IT")).toBe(
      DebugOutpostEndpointsType.UNKNOWN
    )
  })
})
