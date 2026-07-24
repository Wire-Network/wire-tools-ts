import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  RunEvidenceParseResultKind,
  parseRunEvidenceIteration
} from "@wireio/test-opp-stress"

import {
  completedPhase,
  saturatedIteration
} from "./runEvidenceSchemaFixtures.js"

describe("schema-v1 phase baseline identity", () => {
  it.each([
    ["empty", createEnvelopeBaseline([])],
    ["sorted nonempty", createEnvelopeBaseline(["baseline-z", "baseline-a"])]
  ])("accepts a canonical %s baseline key set", (_label, baseline) => {
    // Given: a complete iteration with canonical persisted baseline membership.
    const fixture = {
      ...saturatedIteration,
      phases: [
        {
          ...completedPhase,
          baseline: {
            ...completedPhase.baseline,
            identity: baseline.identity,
            baseKeys: baseline.baseKeys
          }
        }
      ]
    }

    // When: the schema-v1 parser receives the persisted membership proof.
    const result = parseRunEvidenceIteration(fixture)

    // Then: canonical empty and sorted nonempty sets are accepted unchanged.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it.each([
    ["non-array", "baseline-a"],
    ["non-string member", ["baseline-a", 1]],
    ["unsorted members", ["baseline-z", "baseline-a"]],
    ["duplicate members", ["baseline-a", "baseline-a"]]
  ])("rejects %s baseline keys", (_label, baseKeys) => {
    // Given: a phase with malformed or noncanonical persisted membership.
    const fixture = {
      ...saturatedIteration,
      phases: [
        {
          ...completedPhase,
          baseline: {
            ...completedPhase.baseline,
            identity: createEnvelopeBaseline(["baseline-a"]).identity,
            baseKeys
          }
        }
      ]
    }

    // When: the boundary parser validates the iteration.
    const result = parseRunEvidenceIteration(fixture)

    // Then: the key set cannot cross the schema-v1 boundary.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: RunEvidenceParseResultKind.Failure }
    })
  })

  it("rejects an identity inconsistent with canonical baseline keys", () => {
    // Given: sorted unique keys paired with a different valid SHA-256 identity.
    const fixture = {
      ...saturatedIteration,
      phases: [
        {
          ...completedPhase,
          baseline: {
            ...completedPhase.baseline,
            identity: createEnvelopeBaseline(["other-key"]).identity,
            baseKeys: createEnvelopeBaseline(["baseline-a"]).baseKeys
          }
        }
      ]
    }

    // When: the boundary parser recomputes baseline identity.
    const result = parseRunEvidenceIteration(fixture)

    // Then: shape-valid but content-inconsistent identity is rejected.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: RunEvidenceParseResultKind.Failure }
    })
  })

  it("accepts the exact lowercase SHA-256 identity form", () => {
    // Given: a complete iteration with a content-addressed phase baseline.
    // When: the schema-v1 parser receives it.
    const result = parseRunEvidenceIteration(saturatedIteration)

    // Then: the canonical identity is accepted unchanged.
    expect(result).toEqual({ ok: true, value: saturatedIteration })
  })

  it.each([
    "baseline-e7c9",
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha512:${"a".repeat(64)}`
  ])("rejects noncanonical baseline identity %s", identity => {
    // Given: a phase whose identity is not exact lowercase SHA-256.
    const fixture = {
      ...saturatedIteration,
      phases: [
        {
          ...completedPhase,
          baseline: { ...completedPhase.baseline, identity }
        }
      ]
    }

    // When: the boundary parser validates the iteration.
    const result = parseRunEvidenceIteration(fixture)

    // Then: no compatibility identity shape is accepted.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: RunEvidenceParseResultKind.Failure }
    })
  })
})
