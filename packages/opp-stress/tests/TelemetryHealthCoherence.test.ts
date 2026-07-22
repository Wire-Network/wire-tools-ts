import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  OppEnvelopeTelemetryIssueCode,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import type { OppEnvelopeTelemetryIssue } from "@wireio/test-opp-stress"

const BaseKey = "87654321-DEPOT_OUTPOST_SOLANA-fedcba9876543210",
  HashIssue = {
    code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
    baseKey: BaseKey,
    context: {
      expectedHashPrefix: "x",
      actualHashPrefix: "y",
      actualSha256: "f".repeat(64)
    }
  } satisfies OppEnvelopeTelemetryIssue,
  ScanIssue = globalIssue(OppEnvelopeTelemetryIssueCode.DirectoryScanFailed),
  BaselineIssue = globalIssue(
    OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed
  )

describe("telemetry health count coherence", () => {
  it("rejects an empty observation with a candidate hash issue and zero candidates", () => {
    // Given: the verifier's empty/candidate-specific counterexample.
    const fixture = healthFixture(OppEnvelopeTelemetryHealthKind.Empty, {
      retryable: true,
      issues: [HashIssue]
    })

    // When: the fixture crosses the runtime parser boundary.
    const parse = () => parseOppEnvelopeTelemetryHealth(fixture)

    // Then: a candidate-specific issue cannot exist without a candidate.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })

  it("rejects degraded health that counts an integrity-failed candidate as valid", () => {
    // Given: the verifier's fully-accounted degraded/hash counterexample.
    const fixture = healthFixture(OppEnvelopeTelemetryHealthKind.Degraded, {
      retryable: false,
      candidateCount: 1,
      validCount: 1,
      issues: [HashIssue]
    })

    // When: the fixture crosses the runtime parser boundary.
    const parse = () => parseOppEnvelopeTelemetryHealth(fixture)

    // Then: a candidate cannot be both valid and integrity-failed.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })

  it.each([ScanIssue, BaselineIssue])(
    "accepts empty health with the global $code issue",
    issue => {
      // Given: no candidates and one global collection failure.
      const fixture = healthFixture(OppEnvelopeTelemetryHealthKind.Empty, {
        retryable: true,
        issues: [issue]
      })

      // When: the retryable empty observation is parsed.
      const parsed = parseOppEnvelopeTelemetryHealth(fixture)

      // Then: global scan/baseline failures remain legal empty observations.
      expect(parsed.kind).toBe(OppEnvelopeTelemetryHealthKind.Empty)
    }
  )

  it.each([ScanIssue, BaselineIssue])(
    "rejects pending publication with the global $code issue",
    issue => {
      // Given: a candidate-bearing pending state with only a global issue.
      const fixture = healthFixture(
        OppEnvelopeTelemetryHealthKind.PendingPublication,
        { retryable: true, candidateCount: 1, issues: [issue] }
      )

      // When: the pending observation is parsed.
      const parse = () => parseOppEnvelopeTelemetryHealth(fixture)

      // Then: pending candidates require candidate-specific issues.
      expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
    }
  )

  it.each([ScanIssue, BaselineIssue])(
    "terminalizes empty global $code health as degraded",
    issue => {
      // Given: a terminal form of an empty global-failure observation.
      const fixture = healthFixture(OppEnvelopeTelemetryHealthKind.Degraded, {
        retryable: false,
        issues: [issue]
      })

      // When: deadline policy output is parsed.
      const parsed = parseOppEnvelopeTelemetryHealth(fixture)

      // Then: terminal degraded health preserves the legal empty/global counts.
      expect(parsed.kind).toBe(OppEnvelopeTelemetryHealthKind.Degraded)
    }
  )

  it("terminalizes an unaccounted candidate observation as degraded", () => {
    // Given: a terminal form of a pending candidate-specific observation.
    const fixture = healthFixture(OppEnvelopeTelemetryHealthKind.Degraded, {
      retryable: false,
      candidateCount: 1,
      issues: [HashIssue]
    })

    // When: deadline policy output is parsed.
    const parsed = parseOppEnvelopeTelemetryHealth(fixture)

    // Then: the unaccounted candidate remains a legal degraded result.
    expect(parsed.kind).toBe(OppEnvelopeTelemetryHealthKind.Degraded)
  })
})

function healthFixture(
  kind: OppEnvelopeTelemetryHealthKind,
  overrides: {
    readonly retryable: boolean
    readonly candidateCount?: number
    readonly validCount?: number
    readonly issues: readonly OppEnvelopeTelemetryIssue[]
  }
) {
  return {
    kind,
    retryable: overrides.retryable,
    candidateCount: overrides.candidateCount ?? 0,
    validCount: overrides.validCount ?? 0,
    filteredCount: 0,
    issueCount: overrides.issues.length,
    issues: overrides.issues
  }
}

function globalIssue(
  code:
    | OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed
    | OppEnvelopeTelemetryIssueCode.DirectoryScanFailed
): OppEnvelopeTelemetryIssue {
  return {
    code,
    baseKey: "$storage",
    context: {
      storageDir: "/tmp/opp-debugging",
      error: {
        name: "Error",
        code: "EIO",
        message: "collection unavailable",
        operation: "readdir"
      }
    }
  }
}
