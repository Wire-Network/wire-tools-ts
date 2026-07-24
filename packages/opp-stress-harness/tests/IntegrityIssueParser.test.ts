import { EnvelopeIntegrityIssueCode } from "@wireio/debugging-shared"

import { isEnvelopeIntegrityIssue } from "@wireio/opp-stress-harness"

describe("isEnvelopeIntegrityIssue", () => {
  it("rejects values that are not records", () => {
    expect(isEnvelopeIntegrityIssue(null)).toBe(false)
    expect(isEnvelopeIntegrityIssue("issue")).toBe(false)
  })

  it("rejects a record missing the required keys", () => {
    expect(
      isEnvelopeIntegrityIssue({
        code: EnvelopeIntegrityIssueCode.UnknownEndpoint
      })
    ).toBe(false)
  })

  it("accepts a well-formed unknown-endpoint issue", () => {
    expect(
      isEnvelopeIntegrityIssue({
        code: EnvelopeIntegrityIssueCode.UnknownEndpoint,
        baseKey: "00000001-DEPOT_OUTPOST_ETHEREUM-abcdef0123456789",
        context: { endpointKey: "DEPOT_OUTPOST_ETHEREUM" }
      })
    ).toBe(true)
  })

  it("rejects an issue whose context shape is wrong for its code", () => {
    expect(
      isEnvelopeIntegrityIssue({
        code: EnvelopeIntegrityIssueCode.UnknownEndpoint,
        baseKey: "00000001-DEPOT_OUTPOST_ETHEREUM-abcdef0123456789",
        context: { wrongKey: "x" }
      })
    ).toBe(false)
  })
})
