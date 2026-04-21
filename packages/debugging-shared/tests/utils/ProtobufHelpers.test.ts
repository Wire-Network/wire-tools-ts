import { endpointsTypeToKey } from "@wire-e2e-tests/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

describe("DebugOutpostEndpointsType", () => {
  it("UNKNOWN is 0", () => {
    expect(DebugOutpostEndpointsType.UNKNOWN).toBe(0)
  })

  it("OUTPOST_ETHEREUM_DEPOT is 1", () => {
    expect(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT).toBe(1)
  })

  it("OUTPOST_SOLANA_DEPOT is 2", () => {
    expect(DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT).toBe(2)
  })

  it("DEPOT_OUTPOST_ETHEREUM is 3", () => {
    expect(DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM).toBe(3)
  })

  it("DEPOT_OUTPOST_SOLANA is 4", () => {
    expect(DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA).toBe(4)
  })
})

describe("endpointsTypeToKey", () => {
  it("maps each non-UNKNOWN type to a non-null string", () => {
    const types = [
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    ]
    types.forEach(t => {
      const key = endpointsTypeToKey(t)
      expect(key).not.toBeNull()
      expect(typeof key).toBe("string")
    })
  })

  it("returns unique keys for all non-UNKNOWN types", () => {
    const types = [
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    ]
    const keys = types.map(endpointsTypeToKey)
    const unique = new Set(keys)
    expect(unique.size).toBe(types.length)
  })

  it("returns the enum name string for UNKNOWN (value 0)", () => {
    expect(endpointsTypeToKey(DebugOutpostEndpointsType.UNKNOWN)).toBe(
      "UNKNOWN"
    )
  })

  it("returns null for an out-of-range value", () => {
    expect(endpointsTypeToKey(999 as DebugOutpostEndpointsType)).toBeNull()
  })
})
