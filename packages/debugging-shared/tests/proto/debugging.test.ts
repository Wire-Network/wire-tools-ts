import {
   DebugOutpostEndpointsType,
   endpointsTypeToKey,
   generateStorageKey
} from "@wire-e2e-tests/debugging-shared"

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
         DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
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
         DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      ]
      const keys = types.map(endpointsTypeToKey)
      const unique = new Set(keys)
      expect(unique.size).toBe(types.length)
   })

   it("returns the enum name string for UNKNOWN (value 0)", () => {
      expect(endpointsTypeToKey(DebugOutpostEndpointsType.UNKNOWN))
         .toBe("UNKNOWN")
   })

   it("returns null for an out-of-range value", () => {
      expect(endpointsTypeToKey(999 as DebugOutpostEndpointsType))
         .toBeNull()
   })
})

describe("generateStorageKey", () => {
   it("pads epoch index to 8 digits", () => {
      const key = generateStorageKey(1, "test-key", "abc123")
      expect(key).toMatch(/^00000001-/)
   })

   it("includes the endpoints key and checksum", () => {
      const key = generateStorageKey(42, "my-endpoint", "deadbeef")
      expect(key).toContain("my-endpoint")
      expect(key).toContain("deadbeef")
   })

   it("produces lexicographically ordered keys for sequential epochs", () => {
      const key1 = generateStorageKey(1, "ep", "cs")
      const key2 = generateStorageKey(2, "ep", "cs")
      const key10 = generateStorageKey(10, "ep", "cs")
      expect(key1 < key2).toBe(true)
      expect(key2 < key10).toBe(true)
   })

   it("differentiates by endpoints for same epoch and checksum", () => {
      const keyA = generateStorageKey(1, "endpoint-a", "same")
      const keyB = generateStorageKey(1, "endpoint-b", "same")
      expect(keyA).not.toBe(keyB)
   })
})
