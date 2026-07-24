import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  EnvelopeStorageKeyValidationIssue,
  parseEnvelopeStorageKey,
  resolveEndpointsType,
  validateEnvelopeStorageKey
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

describe("validateEnvelopeStorageKey", () => {
  it("exposes stable serialized issue codes", () => {
    expect(EnvelopeStorageKeyValidationIssue).toEqual({
      Format: "format",
      Epoch: "epoch",
      Endpoints: "endpoints",
      Checksum: "checksum"
    })
  })

  it("returns the parsed key for a canonical storage key", () => {
    expect(
      validateEnvelopeStorageKey(
        "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890"
      )
    ).toEqual({
      kind: "valid",
      value: {
        key: "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890",
        epochIndex: 42,
        endpointsKey: "OUTPOST_ETHEREUM_DEPOT",
        checksum: "abc123def4567890"
      }
    })
  })

  it.each([
    [
      "bad epoch padding",
      "42-OUTPOST_ETHEREUM_DEPOT-abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Epoch
    ],
    [
      "numeric epoch prefix",
      "00000042x-OUTPOST_ETHEREUM_DEPOT-abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Epoch
    ],
    [
      "signed epoch prefix",
      "+0000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Epoch
    ],
    [
      "unknown endpoints",
      "00000042-ZZZ_NEVER_HEARD_OF_IT-abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Endpoints
    ],
    [
      "UNKNOWN endpoints",
      "00000042-UNKNOWN-abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Endpoints
    ],
    [
      "empty endpoints",
      "00000042--abc123def4567890",
      EnvelopeStorageKeyValidationIssue.Endpoints
    ],
    [
      "uppercase checksum",
      "00000042-OUTPOST_ETHEREUM_DEPOT-ABC123def4567890",
      EnvelopeStorageKeyValidationIssue.Checksum
    ],
    [
      "non-hex checksum",
      "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def456789g",
      EnvelopeStorageKeyValidationIssue.Checksum
    ],
    [
      "short checksum",
      "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def456789",
      EnvelopeStorageKeyValidationIssue.Checksum
    ]
  ])("returns %s for a %s", (_label, key, issue) => {
    expect(validateEnvelopeStorageKey(key)).toEqual({ kind: "invalid", issue })
  })
})
