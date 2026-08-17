import { EnvelopeIntegrityIssueCode } from "@wireio/test-flow-swap-stress-saturation/envelope-integrity/index.js"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  OppEnvelopeTelemetryIssueCode,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"

import {
  GlobalIntegrityIssueCodes,
  IntegrityIssueFixtures
} from "./telemetryIssueTestFixtures.js"

describe("telemetry integrity issue parsing", () => {
  it.each(IntegrityIssueFixtures)(
    "parses the strict $code issue losslessly",
    strictIssue => {
      // Given: one exact strict-reader issue variant, consumed by telemetry
      // AS-IS (telemetry's issue type aliases the strict reader's).
      const isGlobal = GlobalIntegrityIssueCodes.some(
          code => code === strictIssue.code
        ),
        health = {
          kind: isGlobal
            ? OppEnvelopeTelemetryHealthKind.Empty
            : OppEnvelopeTelemetryHealthKind.PendingPublication,
          retryable: true,
          candidateCount: isGlobal ? 0 : 1,
          validCount: 0,
          filteredCount: 0,
          issueCount: 1,
          issues: [strictIssue]
        }

      // When: the issue crosses the exact telemetry parser boundary.
      const parsed = parseOppEnvelopeTelemetryHealth(health)

      // Then: code, scope key, and structured context survive unchanged, and
      // the issue stays JSON-round-trippable.
      expect(parsed.issues).toEqual([strictIssue])
      expect(JSON.parse(JSON.stringify(strictIssue))).toEqual(strictIssue)
    }
  )

  it("covers all 25 strict and telemetry issue codes exactly once", () => {
    // Given: the exhaustive strict fixture matrix and both closed code enums.

    // When: their serialized code strings are sorted.
    const fixtureCodes = IntegrityIssueFixtures.map(issue => issue.code).sort(),
      strictCodes = Object.values(EnvelopeIntegrityIssueCode).sort(),
      telemetryCodes = Object.values(OppEnvelopeTelemetryIssueCode).sort()

    // Then: no strict classification is normalized, dropped, or duplicated.
    expect(fixtureCodes).toHaveLength(25)
    expect(fixtureCodes).toEqual(strictCodes)
    expect(telemetryCodes).toEqual(strictCodes)
  })

  it("accepts an empty malformed-candidate base key", () => {
    // Given: the strict invalid-key fixture whose discovered base key is empty.
    const issue = IntegrityIssueFixtures[0]

    // When: pending candidate health is parsed.
    const parsed = parseOppEnvelopeTelemetryHealth({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount: 1,
      validCount: 0,
      filteredCount: 0,
      issueCount: 1,
      issues: [issue]
    })

    // Then: the malformed key is preserved rather than replaced by a policy label.
    expect(parsed.issues[0]?.baseKey).toBe("")
  })

  it("rejects a global issue outside the $storage scope", () => {
    // Given: an otherwise exact global issue with a candidate-like scope key.
    const globalIssue =
        IntegrityIssueFixtures[IntegrityIssueFixtures.length - 1],
      health = {
        kind: OppEnvelopeTelemetryHealthKind.Empty,
        retryable: true,
        candidateCount: 0,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [{ ...globalIssue, baseKey: "candidate" }]
      }

    // When: exact telemetry parsing is attempted.
    const parse = () => parseOppEnvelopeTelemetryHealth(health)

    // Then: scope classification comes from the code and rejects the wrong key.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })

  it("rejects a legacy file-error shape", () => {
    // Given: a read issue that omits strict code and operation diagnostics.
    const readIssue = IntegrityIssueFixtures[8],
      health = {
        kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
        retryable: true,
        candidateCount: 1,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [
          {
            ...readIssue,
            context: {
              path: "/tmp/sidecar",
              error: { name: "Error", message: "legacy" }
            }
          }
        ]
      }

    // When: exact telemetry parsing is attempted.
    const parse = () => parseOppEnvelopeTelemetryHealth(health)

    // Then: no legacy context alternative is accepted.
    expect(parse).toThrow(OppEnvelopeTelemetryHealthParseError)
  })
})
